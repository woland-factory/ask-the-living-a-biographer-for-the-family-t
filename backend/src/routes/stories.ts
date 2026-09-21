import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { isUuid } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";
import { chat as defaultChat, resolveLlmAccess, type ChatFn } from "../lib/llm.js";
import { copyViolations } from "../lib/copy-rules.js";
import {
  canViewStory,
  generateStoryQuestions,
  getStoryTellings,
} from "../lib/stories.js";
import { DEMO } from "../seed.js";

export interface StoryDeps {
  config: AppConfig;
  chat?: ChatFn;
}

const TELLINGS_LIMIT = 500;
const STORIES_LIMIT = 200;
const LABEL_MAX = 120;
const SUGGEST_TIMEOUT_MS = 20_000;

interface Membership {
  id: string;
  role: string;
}

async function memberOf(
  db: Db,
  userId: string,
  spaceId: string
): Promise<Membership | null> {
  const { rows } = await db.query<Membership>(
    "SELECT id, role FROM memberships WHERE space_id = $1 AND user_id = $2",
    [spaceId, userId]
  );
  return rows[0] ?? null;
}

/** Confirm the caller is a member of the space. Mirrors questions.ts. */
async function requireSpaceMember(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  spaceId: string
): Promise<Membership | null> {
  if (!isUuid(spaceId)) {
    reply.code(404).send({ error: copy.notFound });
    return null;
  }
  const membership = await memberOf(db, req.user!.id, spaceId);
  if (!membership) {
    const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [spaceId]);
    if (exists.rows.length === 0) reply.code(404).send({ error: copy.notFound });
    else reply.code(403).send({ error: copy.forbidden });
    return null;
  }
  return membership;
}

interface OpenQuestionRow {
  id: string;
  text: string;
  topic: string;
  membership_id: string;
}

/**
 * Build the side-by-side payload for a story: each teller's answers verbatim
 * and the single open cross-telling question posed to them. There is
 * deliberately no field that combines the tellings. audioBase set to null
 * yields transcript-only tellings (the public demo).
 */
async function buildSideBySide(
  db: Db,
  storyId: string,
  audioBase: string | null
) {
  const tellings = await getStoryTellings(db, storyId);
  const open = await db.query<OpenQuestionRow>(
    `SELECT id, text, topic, membership_id FROM questions
      WHERE story_id = $1 AND origin = 'crosstelling' AND status = 'open'`,
    [storyId]
  );
  const openByMember = new Map<string, OpenQuestionRow>();
  for (const q of open.rows) openByMember.set(q.membership_id, q);

  return tellings.map((t) => ({
    membership_id: t.membership_id,
    relationship_to_subject: t.relationship_to_subject,
    display_name: t.display_name,
    answers: t.answers.map((a) => ({
      id: a.id,
      topic: a.topic,
      prompt_text: a.prompt_text,
      transcript: a.transcript,
      transcript_status: a.transcript_status,
      duration_ms: a.duration_ms,
      has_audio: a.has_audio,
      audio_url: audioBase && a.has_audio ? `${audioBase}/${a.id}` : null,
      created_at: a.created_at,
    })),
    open_question: openByMember.has(t.membership_id)
      ? {
          id: openByMember.get(t.membership_id)!.id,
          text: openByMember.get(t.membership_id)!.text,
          topic: openByMember.get(t.membership_id)!.topic,
        }
      : null,
  }));
}

/** Ask the model which existing story a telling belongs to, or a new label. */
async function suggestLabel(
  chat: ChatFn,
  access: { baseUrl: string; apiKey: string; model: string },
  args: { subjectName: string; transcript: string; labels: string[] }
): Promise<string | null> {
  const system = [
    "You help a family group their tellings of shared memories.",
    "Read one telling and reply with a short label naming the memory it is about.",
    "If it clearly matches one of the existing labels, reply with that exact label.",
    "Otherwise reply with a new short label, at most six words.",
    "Reply with only the label. No preamble, no punctuation at the end.",
  ].join("\n");
  const existing =
    args.labels.length > 0
      ? `Existing labels:\n${args.labels.map((l) => `- ${l}`).join("\n")}`
      : "There are no existing labels yet.";
  const user = `About ${args.subjectName}.\n${existing}\n\nThe telling:\n${args.transcript}`;
  const text = await chat({
    baseUrl: access.baseUrl,
    apiKey: access.apiKey,
    model: access.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    timeoutMs: SUGGEST_TIMEOUT_MS,
  });
  const cleaned = text
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:[-*\d.)]+\s*)?/, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  if (cleaned.length === 0 || cleaned.length > LABEL_MAX) return null;
  return cleaned;
}

export function registerStoryRoutes(
  app: FastifyInstance,
  db: Db,
  deps: StoryDeps
): void {
  const requireAuth = makeRequireAuth(db);
  const mutate = { rateLimit: { max: 60, timeWindow: "1 minute" } };
  const publicRead = { rateLimit: { max: 60, timeWindow: "1 minute" } };
  const { config } = deps;
  const chatFn = deps.chat ?? defaultChat;

  // Grouping candidates: the caller's own tellings always, plus (for the
  // organizer) every member's safe metadata. Never another member's transcript.
  app.get("/spaces/:id/tellings", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const membership = await requireSpaceMember(db, req, reply, id);
    if (!membership) return reply;

    const isOrganizer = membership.role === "organizer";
    const params: unknown[] = [id];
    let where = "a.space_id = $1";
    if (!isOrganizer) {
      params.push(membership.id);
      where += ` AND a.membership_id = $${params.length}`;
    }

    const { rows } = await db.query<{
      answer_id: string;
      membership_id: string;
      relationship_to_subject: string | null;
      display_name: string | null;
      topic: string;
      prompt_text: string;
      story_id: string | null;
      transcript_status: string;
      created_at: string;
    }>(
      `SELECT a.id AS answer_id, a.membership_id, a.topic, a.prompt_text,
              a.story_id, a.transcript_status, a.created_at,
              m.relationship_to_subject, u.display_name
         FROM answers a
         JOIN memberships m ON m.id = a.membership_id
         JOIN users u ON u.id = m.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT ${TELLINGS_LIMIT}`,
      params
    );

    const tellings = rows.map((r) => ({
      answer_id: r.answer_id,
      membership_id: r.membership_id,
      relationship_to_subject: r.relationship_to_subject,
      display_name: r.display_name,
      topic: r.topic,
      prompt_text: r.prompt_text,
      story_id: r.story_id,
      transcript_status: r.transcript_status,
      created_at: r.created_at,
      is_own: r.membership_id === membership.id,
    }));
    return reply.code(200).send({ tellings });
  });

  // Create a story: a lightweight grouping label.
  app.post(
    "/spaces/:id/stories",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["label"],
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: LABEL_MAX },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const membership = await requireSpaceMember(db, req, reply, id);
      if (!membership) return reply;

      const label = (req.body as { label: string }).label.trim();
      if (label.length === 0) return reply.code(400).send({ error: copy.validation });

      const created = await db.query<{ id: string; label: string; created_at: string }>(
        `INSERT INTO stories (space_id, label, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, label, created_at`,
        [id, label, membership.id]
      );
      return reply.code(201).send(created.rows[0]);
    }
  );

  // Tag or untag a telling. The alignment/consent act: an organizer may tag
  // another member's answer, and doing so opens the story for its tellers.
  app.post(
    "/answers/:id/story",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["story_id"],
          additionalProperties: false,
          properties: {
            story_id: { type: ["string", "null"], maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const answer = await db.query<{
        id: string;
        space_id: string;
        membership_id: string;
      }>("SELECT id, space_id, membership_id FROM answers WHERE id = $1", [id]);
      if (answer.rows.length === 0) return reply.code(404).send({ error: copy.notFound });
      const row = answer.rows[0];

      const membership = await memberOf(db, req.user!.id, row.space_id);
      if (!membership) return reply.code(403).send({ error: copy.forbidden });
      // Own the answer, or be the organizer. Nothing else touches a telling.
      if (membership.id !== row.membership_id && membership.role !== "organizer") {
        return reply.code(403).send({ error: copy.sittingPrivate });
      }

      const { story_id } = req.body as { story_id: string | null };
      if (story_id !== null) {
        if (!isUuid(story_id)) return reply.code(400).send({ error: copy.validation });
        const story = await db.query("SELECT 1 FROM stories WHERE id = $1 AND space_id = $2", [
          story_id,
          row.space_id,
        ]);
        if (story.rows.length === 0) return reply.code(400).send({ error: copy.validation });
      }

      await db.query("UPDATE answers SET story_id = $2 WHERE id = $1", [id, story_id]);

      let generated = 0;
      if (story_id !== null) {
        const access = await resolveLlmAccess(db, req.user!, config);
        const space = await db.query<{ subject_name: string }>(
          "SELECT subject_name FROM spaces WHERE id = $1",
          [row.space_id]
        );
        const subjectName = space.rows[0]?.subject_name ?? "them";
        try {
          const created = await generateStoryQuestions(db, {
            storyId: story_id,
            access,
            chat: chatFn,
            subjectName,
          });
          generated = created.length;
        } catch {
          // A failed generation never blocks the tag. Silence is safe.
        }
      }

      return reply.code(200).send({ answer_id: id, story_id, generated });
    }
  );

  // LLM-assisted tag suggestion. Proposes only; never tags.
  app.post(
    "/answers/:id/story-suggestions",
    { preHandler: requireAuth, config: mutate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const answer = await db.query<{
        space_id: string;
        membership_id: string;
        transcript: string | null;
        transcript_status: string;
      }>(
        "SELECT space_id, membership_id, transcript, transcript_status FROM answers WHERE id = $1",
        [id]
      );
      if (answer.rows.length === 0) return reply.code(404).send({ error: copy.notFound });
      const row = answer.rows[0];

      const membership = await memberOf(db, req.user!.id, row.space_id);
      if (!membership) return reply.code(403).send({ error: copy.forbidden });
      if (membership.id !== row.membership_id && membership.role !== "organizer") {
        return reply.code(403).send({ error: copy.sittingPrivate });
      }

      const access = await resolveLlmAccess(db, req.user!, config);
      const transcript = (row.transcript ?? "").trim();
      if (row.transcript_status !== "done" || transcript.length === 0) {
        return reply
          .code(200)
          .send({ mode: access.mode, suggestions: [], suggested_label: null });
      }
      if (access.mode === "off") {
        return reply.code(200).send({ mode: "off", suggestions: [], suggested_label: null });
      }

      const stories = await db.query<{ id: string; label: string }>(
        "SELECT id, label FROM stories WHERE space_id = $1 ORDER BY created_at DESC LIMIT $2",
        [row.space_id, STORIES_LIMIT]
      );
      const space = await db.query<{ subject_name: string }>(
        "SELECT subject_name FROM spaces WHERE id = $1",
        [row.space_id]
      );
      const subjectName = space.rows[0]?.subject_name ?? "them";

      let proposed: string | null = null;
      try {
        proposed = await suggestLabel(
          chatFn,
          { baseUrl: access.baseUrl, apiKey: access.apiKey, model: access.model },
          { subjectName, transcript, labels: stories.rows.map((s) => s.label) }
        );
      } catch {
        proposed = null;
      }

      if (!proposed) {
        return reply
          .code(200)
          .send({ mode: access.mode, suggestions: [], suggested_label: null });
      }

      const match = stories.rows.find(
        (s) => s.label.trim().toLowerCase() === proposed!.trim().toLowerCase()
      );
      if (match) {
        return reply.code(200).send({
          mode: access.mode,
          suggestions: [{ story_id: match.id, label: match.label }],
          suggested_label: null,
        });
      }

      const suggestedLabel = copyViolations(proposed).length === 0 ? proposed : null;
      return reply
        .code(200)
        .send({ mode: access.mode, suggestions: [], suggested_label: suggestedLabel });
    }
  );

  // Every story in the space with its teller count and readiness.
  app.get("/spaces/:id/stories", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const membership = await requireSpaceMember(db, req, reply, id);
    if (!membership) return reply;

    const { rows } = await db.query<{
      id: string;
      label: string;
      created_at: string;
      teller_count: number;
    }>(
      `SELECT s.id, s.label, s.created_at,
              COUNT(DISTINCT a.membership_id)::int AS teller_count
         FROM stories s
         LEFT JOIN answers a ON a.story_id = s.id
        WHERE s.space_id = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT ${STORIES_LIMIT}`,
      [id]
    );
    const stories = rows.map((r) => ({
      id: r.id,
      label: r.label,
      teller_count: Number(r.teller_count),
      ready: Number(r.teller_count) >= 2,
      created_at: r.created_at,
    }));
    return reply.code(200).send({ stories });
  });

  // The side-by-side surface. Gated by the consented-reveal rule.
  app.get("/spaces/:id/stories/:sid", { preHandler: requireAuth }, async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const membership = await requireSpaceMember(db, req, reply, id);
    if (!membership) return reply;
    if (!isUuid(sid)) return reply.code(404).send({ error: copy.notFound });

    const story = await db.query<{ id: string; label: string; created_at: string }>(
      "SELECT id, label, created_at FROM stories WHERE id = $1 AND space_id = $2",
      [sid, id]
    );
    if (story.rows.length === 0) return reply.code(404).send({ error: copy.notFound });

    if (!(await canViewStory(db, membership, sid))) {
      return reply.code(403).send({ error: copy.storyPrivate });
    }

    const tellings = await buildSideBySide(db, sid, `/spaces/${id}/stories/${sid}/audio`);
    return reply.code(200).send({ story: story.rows[0], tellings });
  });

  // Story-scoped audio: the only relaxation of the per-sitting audio wall, and
  // only for a story the caller has joined.
  app.get(
    "/spaces/:id/stories/:sid/audio/:answerId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, sid, answerId } = req.params as {
        id: string;
        sid: string;
        answerId: string;
      };
      const membership = await requireSpaceMember(db, req, reply, id);
      if (!membership) return reply;
      if (!isUuid(sid) || !isUuid(answerId)) {
        return reply.code(404).send({ error: copy.notFound });
      }

      const story = await db.query("SELECT 1 FROM stories WHERE id = $1 AND space_id = $2", [
        sid,
        id,
      ]);
      if (story.rows.length === 0) return reply.code(404).send({ error: copy.notFound });

      if (!(await canViewStory(db, membership, sid))) {
        return reply.code(403).send({ error: copy.storyPrivate });
      }

      const answer = await db.query<{ audio_mime: string | null }>(
        "SELECT audio_mime FROM answers WHERE id = $1 AND story_id = $2",
        [answerId, sid]
      );
      if (answer.rows.length === 0) return reply.code(404).send({ error: copy.notFound });

      const audio = await db.query<{ bytes: Buffer | Uint8Array }>(
        "SELECT bytes FROM answer_audio WHERE answer_id = $1",
        [answerId]
      );
      if (audio.rows.length === 0) return reply.code(404).send({ error: copy.notFound });

      const bytes = Buffer.from(audio.rows[0].bytes);
      reply
        .header("Content-Type", answer.rows[0].audio_mime ?? "application/octet-stream")
        .header("Content-Length", String(bytes.length))
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", "inline");
      return reply.code(200).send(bytes);
    }
  );

  // The public demo bridge. Read-only, demo space only, transcript-only.
  app.get("/demo/story", { config: publicRead }, async (_req, reply) => {
    const demo = await db.query<{ story_id: string }>(
      `SELECT st.id AS story_id
         FROM stories st
         JOIN memberships m ON m.space_id = st.space_id AND m.role = 'organizer'
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1
        ORDER BY st.created_at ASC
        LIMIT 1`,
      [DEMO.email]
    );
    if (demo.rows.length === 0) return reply.code(404).send({ error: copy.notFound });

    const storyId = demo.rows[0].story_id;
    const story = await db.query<{ id: string; label: string; created_at: string }>(
      "SELECT id, label, created_at FROM stories WHERE id = $1",
      [storyId]
    );
    const tellings = await buildSideBySide(db, storyId, null);
    return reply.code(200).send({ story: story.rows[0], tellings });
  });
}
