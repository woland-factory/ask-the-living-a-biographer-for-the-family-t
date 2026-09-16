import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { isUuid } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";
import { BANK, seedBankQuestions } from "../interview/bank.js";

const QUESTION_LIMIT = 500; // A family's map is bounded (16 bank + follow-ups).
// If a space ever exceeds this, pagination is the extension point here.
const STATUSES = new Set(["open", "answered", "deferred", "lost"]);
const KNOWN_TOPICS = new Set(BANK.map((b) => b.topic));

interface QuestionRow {
  id: string;
  space_id: string;
  membership_id: string | null;
  origin: string;
  topic: string;
  text: string;
  status: string;
  parent_answer_id: string | null;
  assigned_to: string | null;
  created_at: string;
}

const QUESTION_COLUMNS = `id, space_id, membership_id, origin, topic, text, status,
              parent_answer_id, assigned_to, created_at`;

function questionView(row: QuestionRow) {
  return {
    id: row.id,
    text: row.text,
    topic: row.topic,
    origin: row.origin,
    status: row.status,
    membership_id: row.membership_id,
    parent_answer_id: row.parent_answer_id,
    assigned_to: row.assigned_to,
    created_at: row.created_at,
  };
}

async function membershipFor(db: Db, userId: string, spaceId: string) {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM memberships WHERE space_id = $1 AND user_id = $2",
    [spaceId, userId]
  );
  return rows[0] ?? null;
}

/** Confirm the caller is a member of the space. Mirrors GET /spaces/:id. */
async function requireSpaceMember(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  spaceId: string
): Promise<boolean> {
  if (!isUuid(spaceId)) {
    reply.code(404).send({ error: copy.notFound });
    return false;
  }
  const membership = await membershipFor(db, req.user!.id, spaceId);
  if (!membership) {
    const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [spaceId]);
    if (exists.rows.length === 0) reply.code(404).send({ error: copy.notFound });
    else reply.code(403).send({ error: copy.forbidden });
    return false;
  }
  return true;
}

export function registerQuestionRoutes(app: FastifyInstance, db: Db): void {
  const requireAuth = makeRequireAuth(db);
  const mutate = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  // The gap map for a space: open questions with filters, plus stable counts.
  app.get("/spaces/:id/questions", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireSpaceMember(db, req, reply, id))) return reply;

    // Seed the bank idempotently so a space made before this migration fills in.
    await seedBankQuestions(db, id);

    const q = req.query as { status?: string; topic?: string; membership_id?: string };

    const where: string[] = ["space_id = $1"];
    const params: unknown[] = [id];

    if (q.status !== undefined) {
      if (!STATUSES.has(q.status)) return reply.code(400).send({ error: copy.validation });
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    if (q.topic !== undefined) {
      if (!KNOWN_TOPICS.has(q.topic)) return reply.code(400).send({ error: copy.validation });
      params.push(q.topic);
      where.push(`topic = $${params.length}`);
    }
    if (q.membership_id !== undefined) {
      if (q.membership_id === "anyone") {
        where.push("membership_id IS NULL");
      } else if (isUuid(q.membership_id)) {
        params.push(q.membership_id);
        where.push(`membership_id = $${params.length}`);
      } else {
        return reply.code(400).send({ error: copy.validation });
      }
    }

    const list = await db.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS}
         FROM questions
        WHERE ${where.join(" AND ")}
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT ${QUESTION_LIMIT}`,
      params
    );

    // Counts are unfiltered (whole space) so the open-count stays stable while
    // the user filters the list.
    const countRows = await db.query<{ status: string; n: string }>(
      "SELECT status, COUNT(*)::int AS n FROM questions WHERE space_id = $1 GROUP BY status",
      [id]
    );
    const counts = { open: 0, answered: 0, deferred: 0, lost: 0, total: 0 };
    for (const r of countRows.rows) {
      const n = Number(r.n);
      if (r.status in counts) (counts as Record<string, number>)[r.status] = n;
      counts.total += n;
    }

    const people = await db.query<{
      membership_id: string;
      relationship_to_subject: string | null;
      display_name: string | null;
    }>(
      `SELECT m.id AS membership_id, m.relationship_to_subject, u.display_name
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 ORDER BY m.created_at ASC`,
      [id]
    );

    const topicRows = await db.query<{ topic: string }>(
      "SELECT DISTINCT topic FROM questions WHERE space_id = $1",
      [id]
    );
    // Order topics by their bank order for a calm, familiar sequence.
    const bankOrder = BANK.map((b) => b.topic);
    const topics = topicRows.rows
      .map((r) => r.topic)
      .sort((a, b) => bankOrder.indexOf(a) - bankOrder.indexOf(b));

    return reply.code(200).send({
      questions: list.rows.map(questionView),
      counts,
      people: people.rows,
      topics,
    });
  });

  // Move a question's status by hand (defer, lost with them, reopen, resolve).
  app.patch(
    "/questions/:id",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["open", "answered", "deferred", "lost"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const found = await db.query<QuestionRow>(
        `SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = $1`,
        [id]
      );
      if (found.rows.length === 0) return reply.code(404).send({ error: copy.notFound });
      const question = found.rows[0];

      const membership = await membershipFor(db, req.user!.id, question.space_id);
      if (!membership) return reply.code(403).send({ error: copy.forbidden });

      const { status } = req.body as { status: string };
      const updated = await db.query<QuestionRow>(
        `UPDATE questions
            SET status = $2,
                resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
          WHERE id = $1
        RETURNING ${QUESTION_COLUMNS}`,
        [id, status]
      );
      return reply.code(200).send(questionView(updated.rows[0]));
    }
  );

  // Carry a question to a specific family member (or clear the routing).
  // "We thought you might know" - family asking family, never a task assigned.
  app.post(
    "/questions/:id/route",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["membership_id"],
          additionalProperties: false,
          properties: {
            membership_id: { type: ["string", "null"], maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return reply.code(404).send({ error: copy.notFound });

      const found = await db.query<QuestionRow>(
        `SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = $1`,
        [id]
      );
      if (found.rows.length === 0) return reply.code(404).send({ error: copy.notFound });
      const question = found.rows[0];

      const membership = await membershipFor(db, req.user!.id, question.space_id);
      if (!membership) return reply.code(403).send({ error: copy.forbidden });

      // Only an open question can be routed or unrouted.
      if (question.status !== "open") {
        return reply.code(400).send({ error: copy.validation });
      }

      const { membership_id } = req.body as { membership_id: string | null };
      if (membership_id !== null) {
        if (!isUuid(membership_id)) {
          return reply.code(400).send({ error: copy.validation });
        }
        // A routing target must be a member of the question's own space.
        const target = await db.query(
          "SELECT 1 FROM memberships WHERE id = $1 AND space_id = $2",
          [membership_id, question.space_id]
        );
        if (target.rows.length === 0) {
          return reply.code(400).send({ error: copy.validation });
        }
      }

      const updated = await db.query<QuestionRow>(
        `UPDATE questions
            SET assigned_to = $2,
                routed_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() END
          WHERE id = $1
        RETURNING ${QUESTION_COLUMNS}`,
        [id, membership_id]
      );
      return reply.code(200).send(questionView(updated.rows[0]));
    }
  );
}
