import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { isUuid } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";
import { chat as defaultChat, resolveLlmAccess, type ChatFn } from "../lib/llm.js";
import { generateFollowups } from "../lib/followups.js";
import { seedBankQuestions } from "../interview/bank.js";

export interface InterviewDeps {
  config: AppConfig;
  chat?: ChatFn;
}

const FOLLOWUP_CAP = 2; // At most two open follow-ups per answer.

// 12 MB cap on a single recording's bytes. The client also caps length.
const AUDIO_BODY_LIMIT = 12 * 1024 * 1024;
const ANSWERS_LIST_LIMIT = 200;
const FOLLOWUP_LIST_LIMIT = 50; // Bound the open-follow-ups read like every other list.

const ALLOWED_AUDIO_MIME = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
]);

interface SessionRow {
  id: string;
  space_id: string;
  membership_id: string;
  started_at: string;
  ended_at: string | null;
}

interface AnswerRow {
  id: string;
  session_id: string;
  space_id: string;
  membership_id: string;
  bank_question_key: string;
  prompt_text: string;
  topic: string;
  duration_ms: number;
  audio_mime: string | null;
  audio_size: number | null;
  transcript: string | null;
  transcript_status: string;
  question_id: string | null;
  created_at: string;
}

function answerSummary(row: AnswerRow) {
  return {
    id: row.id,
    bank_question_key: row.bank_question_key,
    prompt_text: row.prompt_text,
    topic: row.topic,
    duration_ms: row.duration_ms,
    transcript_status: row.transcript_status,
    transcript: row.transcript,
    created_at: row.created_at,
  };
}

/** The caller's membership row in a space, or null if they are not a member. */
async function membershipFor(
  db: Db,
  userId: string,
  spaceId: string
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM memberships WHERE space_id = $1 AND user_id = $2",
    [spaceId, userId]
  );
  return rows[0] ?? null;
}

async function loadSession(db: Db, id: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT id, space_id, membership_id, started_at, ended_at
       FROM interview_sessions WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

async function loadAnswer(db: Db, id: string): Promise<AnswerRow | null> {
  const { rows } = await db.query<AnswerRow>(
    `SELECT id, session_id, space_id, membership_id, bank_question_key,
            prompt_text, topic, duration_ms, audio_mime, audio_size,
            transcript, transcript_status, question_id, created_at
       FROM answers WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Resolve a session by id and confirm the caller is a member of its space.
 * Mirrors GET /spaces/:id: unknown id -> 404, not-the-caller's -> 403.
 */
async function requireSession(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string
): Promise<SessionRow | null> {
  if (!isUuid(id)) {
    reply.code(404).send({ error: copy.notFound });
    return null;
  }
  const session = await loadSession(db, id);
  if (!session) {
    reply.code(404).send({ error: copy.notFound });
    return null;
  }
  const membership = await membershipFor(db, req.user!.id, session.space_id);
  if (!membership) {
    reply.code(403).send({ error: copy.forbidden });
    return null;
  }
  // A sitting is private to its own teller. Another family member sharing the
  // space does not grant access to this raw session or its audio.
  if (membership.id !== session.membership_id) {
    reply.code(403).send({ error: copy.sittingPrivate });
    return null;
  }
  return session;
}

async function requireAnswer(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string
): Promise<AnswerRow | null> {
  if (!isUuid(id)) {
    reply.code(404).send({ error: copy.notFound });
    return null;
  }
  const answer = await loadAnswer(db, id);
  if (!answer) {
    reply.code(404).send({ error: copy.notFound });
    return null;
  }
  const membership = await membershipFor(db, req.user!.id, answer.space_id);
  if (!membership) {
    reply.code(403).send({ error: copy.forbidden });
    return null;
  }
  // An answer and its audio are private to the teller who recorded them.
  if (membership.id !== answer.membership_id) {
    reply.code(403).send({ error: copy.sittingPrivate });
    return null;
  }
  return answer;
}

export function registerInterviewRoutes(
  app: FastifyInstance,
  db: Db,
  deps: InterviewDeps
): void {
  const requireAuth = makeRequireAuth(db);
  const mutate = { rateLimit: { max: 60, timeWindow: "1 minute" } };
  const { config } = deps;
  const chatFn = deps.chat ?? defaultChat;

  // 1. Start or resume the caller's open session in a space.
  app.post(
    "/spaces/:id/sessions",
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const membership = await membershipFor(db, req.user!.id, id);
      if (!membership) {
        const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [id]);
        if (exists.rows.length === 0)
          return reply.code(404).send({ error: copy.notFound });
        return reply.code(403).send({ error: copy.forbidden });
      }

      // Seed the space's gap map the moment an interview starts.
      await seedBankQuestions(db, id);

      const open = await db.query<SessionRow>(
        `SELECT id, space_id, membership_id, started_at, ended_at
           FROM interview_sessions
          WHERE space_id = $1 AND membership_id = $2 AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
        [id, membership.id]
      );
      if (open.rows.length > 0) return reply.code(200).send(open.rows[0]);

      const created = await db.query<SessionRow>(
        `INSERT INTO interview_sessions (space_id, membership_id)
         VALUES ($1, $2)
         RETURNING id, space_id, membership_id, started_at, ended_at`,
        [id, membership.id]
      );
      return reply.code(201).send(created.rows[0]);
    }
  );

  // 2. Session plus progress for resume across sittings.
  app.get(
    "/sessions/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await requireSession(db, req, reply, id);
      if (!session) return reply;

      const answeredKeys = await db.query<{ bank_question_key: string }>(
        `SELECT DISTINCT bank_question_key FROM answers
          WHERE space_id = $1 AND membership_id = $2`,
        [session.space_id, session.membership_id]
      );
      const deferred = await db.query<{ topic: string }>(
        `SELECT topic FROM topic_deferrals
          WHERE space_id = $1 AND membership_id = $2`,
        [session.space_id, session.membership_id]
      );
      const answers = await db.query<AnswerRow>(
        `SELECT id, session_id, space_id, membership_id, bank_question_key,
                prompt_text, topic, duration_ms, audio_mime, audio_size,
                transcript, transcript_status, question_id, created_at
           FROM answers
          WHERE session_id = $1
          ORDER BY created_at DESC
          LIMIT ${ANSWERS_LIST_LIMIT}`,
        [session.id]
      );
      // Everything open for this member: their own follow-ups, the cross-telling
      // question another teller's version opened for them, plus anything routed
      // to them. A question routed away leaves the teller's queue and joins the
      // target's. Routed items sort first: a question your family sent you is
      // the first thing your next sitting offers.
      const followups = await db.query<{
        id: string;
        text: string;
        topic: string;
        origin: string;
        routed: boolean;
      }>(
        `SELECT q.id, q.text, q.topic, q.origin,
                (q.assigned_to IS NOT NULL) AS routed
           FROM questions q
          WHERE q.space_id = $1 AND q.status = 'open'
            AND (q.assigned_to = $2
                 OR (q.assigned_to IS NULL AND q.origin = 'followup'
                     AND q.membership_id = $2)
                 OR (q.assigned_to IS NULL AND q.origin = 'crosstelling'
                     AND q.membership_id = $2))
          ORDER BY (q.assigned_to IS NOT NULL) DESC, q.created_at DESC
          LIMIT ${FOLLOWUP_LIST_LIMIT}`,
        [session.space_id, session.membership_id]
      );

      return reply.code(200).send({
        session,
        answered_keys: answeredKeys.rows.map((r) => r.bank_question_key),
        deferred_topics: deferred.rows.map((r) => r.topic),
        answers: answers.rows.map(answerSummary),
        followups: followups.rows,
      });
    }
  );

  // 3. Create the answer metadata row (bytes arrive next, via PUT).
  app.post(
    "/sessions/:id/answers",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["bank_question_key", "prompt_text", "topic", "duration_ms"],
          additionalProperties: false,
          properties: {
            bank_question_key: { type: "string", minLength: 1, maxLength: 200 },
            prompt_text: { type: "string", minLength: 1, maxLength: 1000 },
            topic: { type: "string", minLength: 1, maxLength: 100 },
            duration_ms: { type: "integer", minimum: 0, maximum: 1_800_000 },
            question_id: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await requireSession(db, req, reply, id);
      if (!session) return reply;

      const body = req.body as {
        bank_question_key: string;
        prompt_text: string;
        topic: string;
        duration_ms: number;
        question_id?: string;
      };

      // When answering a specific gap-map question, it must belong to this space.
      let questionId: string | null = null;
      if (body.question_id !== undefined) {
        if (!isUuid(body.question_id)) {
          return reply.code(400).send({ error: copy.validation });
        }
        const match = await db.query(
          "SELECT 1 FROM questions WHERE id = $1 AND space_id = $2",
          [body.question_id, session.space_id]
        );
        if (match.rows.length === 0) {
          return reply.code(400).send({ error: copy.validation });
        }
        questionId = body.question_id;
      }

      const created = await db.query<{ id: string; transcript_status: string }>(
        `INSERT INTO answers
           (session_id, space_id, membership_id, bank_question_key, prompt_text, topic, duration_ms, question_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, transcript_status`,
        [
          session.id,
          session.space_id,
          session.membership_id,
          body.bank_question_key,
          body.prompt_text,
          body.topic,
          body.duration_ms,
          questionId,
        ]
      );

      // Resolve the matching gap-map question to answered.
      if (questionId) {
        await db.query(
          "UPDATE questions SET status = 'answered', resolved_at = now() WHERE id = $1 AND status = 'open'",
          [questionId]
        );
      } else {
        await db.query(
          `UPDATE questions SET status = 'answered', resolved_at = now()
            WHERE space_id = $1 AND bank_question_key = $2
              AND origin = 'bank' AND status = 'open'`,
          [session.space_id, body.bank_question_key]
        );
      }

      return reply.code(201).send(created.rows[0]);
    }
  );

  // Generate at most two gentle follow-ups from a saved answer's transcript.
  // Off, no transcript, and any model failure all resolve to an empty list.
  app.post(
    "/answers/:id/followups",
    { preHandler: requireAuth, config: mutate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const answer = await requireAnswer(db, req, reply, id);
      if (!answer) return reply;

      const access = await resolveLlmAccess(db, req.user!, config);
      const transcript = (answer.transcript ?? "").trim();
      if (answer.transcript_status !== "done" || transcript.length === 0) {
        return reply.code(200).send({ followups: [], mode: access.mode });
      }
      if (access.mode === "off") {
        return reply.code(200).send({ followups: [], mode: "off" });
      }

      const space = await db.query<{ subject_name: string }>(
        "SELECT subject_name FROM spaces WHERE id = $1",
        [answer.space_id]
      );
      const subjectName = space.rows[0]?.subject_name ?? "them";

      const candidates = await generateFollowups({
        access,
        chat: chatFn,
        ctx: { subjectName, topicLabel: answer.topic, transcript },
      });

      // De-duplicate against follow-ups already open for this answer, and keep
      // the total per answer at or under the cap.
      const existing = await db.query<{ text: string }>(
        `SELECT text FROM questions
          WHERE parent_answer_id = $1 AND origin = 'followup' AND status = 'open'`,
        [answer.id]
      );
      const existingSet = new Set(existing.rows.map((r) => r.text.trim().toLowerCase()));
      const remaining = Math.max(0, FOLLOWUP_CAP - existing.rows.length);

      const stored: { id: string; text: string; topic: string }[] = [];
      for (const text of candidates) {
        if (stored.length >= remaining) break;
        if (existingSet.has(text.toLowerCase())) continue;
        const ins = await db.query<{ id: string; text: string; topic: string }>(
          `INSERT INTO questions
             (space_id, membership_id, origin, topic, text, parent_answer_id, status)
           VALUES ($1, $2, 'followup', $3, $4, $5, 'open')
           RETURNING id, text, topic`,
          [answer.space_id, answer.membership_id, answer.topic, text, answer.id]
        );
        existingSet.add(text.toLowerCase());
        stored.push(ins.rows[0]);
      }

      return reply.code(200).send({ followups: stored, mode: access.mode });
    }
  );

  // 4. Store the recorded bytes. Raw octet-stream body, its own larger limit.
  app.put(
    "/answers/:id/audio",
    { preHandler: requireAuth, bodyLimit: AUDIO_BODY_LIMIT, config: mutate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const answer = await requireAnswer(db, req, reply, id);
      if (!answer) return reply;

      const mime = String((req.query as { mime?: string }).mime ?? "").trim();
      if (!ALLOWED_AUDIO_MIME.has(mime)) {
        return reply.code(400).send({ error: copy.validation });
      }
      const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.code(400).send({ error: copy.validation });
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO answer_audio (answer_id, bytes)
           VALUES ($1, $2)
           ON CONFLICT (answer_id)
           DO UPDATE SET bytes = EXCLUDED.bytes, created_at = now()`,
          [id, bytes]
        );
        await tx.query(
          "UPDATE answers SET audio_mime = $2, audio_size = $3 WHERE id = $1",
          [id, mime, bytes.length]
        );
      });
      return reply.code(204).send();
    }
  );

  // 5. Attach the transcript result (or record that it failed).
  app.patch(
    "/answers/:id",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["transcript_status"],
          additionalProperties: false,
          properties: {
            transcript_status: { type: "string", enum: ["done", "failed"] },
            transcript: { type: "string", minLength: 0, maxLength: 20000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const answer = await requireAnswer(db, req, reply, id);
      if (!answer) return reply;

      const body = req.body as { transcript_status: "done" | "failed"; transcript?: string };
      if (body.transcript_status === "done") {
        const text = (body.transcript ?? "").trim();
        if (text.length === 0) {
          return reply.code(400).send({ error: copy.validation });
        }
        await db.query(
          "UPDATE answers SET transcript_status = 'done', transcript = $2 WHERE id = $1",
          [id, body.transcript ?? ""]
        );
      } else {
        await db.query(
          "UPDATE answers SET transcript_status = 'failed', transcript = NULL WHERE id = $1",
          [id]
        );
      }

      const updated = await loadAnswer(db, id);
      return reply.code(200).send(answerSummary(updated!));
    }
  );

  // 6. Stream the audio back for playback. Membership-scoped, never cached.
  app.get(
    "/answers/:id/audio",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const answer = await requireAnswer(db, req, reply, id);
      if (!answer) return reply;

      const { rows } = await db.query<{ bytes: Buffer | Uint8Array }>(
        "SELECT bytes FROM answer_audio WHERE answer_id = $1",
        [id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: copy.notFound });

      const bytes = Buffer.from(rows[0].bytes);
      reply
        .header("Content-Type", answer.audio_mime ?? "application/octet-stream")
        .header("Content-Length", String(bytes.length))
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", "inline");
      return reply.code(200).send(bytes);
    }
  );

  // 7. Defer the current topic. Idempotent per (membership, topic).
  app.post(
    "/sessions/:id/defer",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["topic"],
          additionalProperties: false,
          properties: { topic: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await requireSession(db, req, reply, id);
      if (!session) return reply;

      const { topic } = req.body as { topic: string };
      await db.query(
        `INSERT INTO topic_deferrals (space_id, membership_id, topic)
         VALUES ($1, $2, $3)
         ON CONFLICT (space_id, membership_id, topic) DO NOTHING`,
        [session.space_id, session.membership_id, topic]
      );
      return reply.code(200).send({ ok: true });
    }
  );

  // 8. End the sitting. Idempotent.
  app.post(
    "/sessions/:id/complete",
    { preHandler: requireAuth, config: mutate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await requireSession(db, req, reply, id);
      if (!session) return reply;

      const updated = await db.query<{ id: string; ended_at: string }>(
        `UPDATE interview_sessions
            SET ended_at = COALESCE(ended_at, now())
          WHERE id = $1
        RETURNING id, ended_at`,
        [session.id]
      );
      const count = await db.query<{ n: string }>(
        "SELECT COUNT(*)::int AS n FROM answers WHERE session_id = $1",
        [session.id]
      );
      return reply.code(200).send({
        id: updated.rows[0].id,
        ended_at: updated.rows[0].ended_at,
        answered_count: Number(count.rows[0].n),
      });
    }
  );
}
