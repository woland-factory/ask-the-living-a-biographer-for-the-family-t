import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { isUuid } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";

interface SpaceRow {
  id: string;
  subject_name: string;
  subject_birth_year: number | null;
  subject_death_year: number | null;
  created_at?: string;
  role?: string;
}

const YEAR_MIN = 1;
const YEAR_MAX = 3000;
const LIST_LIMIT = 50;

export function registerSpaceRoutes(app: FastifyInstance, db: Db): void {
  const requireAuth = makeRequireAuth(db);

  app.post(
    "/spaces",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["subject_name"],
          additionalProperties: false,
          properties: {
            subject_name: { type: "string", minLength: 1, maxLength: 120 },
            subject_birth_year: {
              type: "integer",
              minimum: YEAR_MIN,
              maximum: YEAR_MAX,
              nullable: true,
            },
            subject_death_year: {
              type: "integer",
              minimum: YEAR_MIN,
              maximum: YEAR_MAX,
              nullable: true,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        subject_name: string;
        subject_birth_year?: number | null;
        subject_death_year?: number | null;
      };
      const userId = req.user!.id;
      const name = body.subject_name.trim();
      if (name.length === 0) {
        return reply.code(400).send({ error: copy.validation });
      }

      const space = await db.transaction(async (tx) => {
        const inserted = await tx.query<SpaceRow>(
          `INSERT INTO spaces (subject_name, subject_birth_year, subject_death_year, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, subject_name, subject_birth_year, subject_death_year`,
          [
            name,
            body.subject_birth_year ?? null,
            body.subject_death_year ?? null,
            userId,
          ]
        );
        const row = inserted.rows[0];
        await tx.query(
          `INSERT INTO memberships (space_id, user_id, role)
           VALUES ($1, $2, 'organizer')`,
          [row.id, userId]
        );
        return row;
      });

      return reply.code(201).send(space);
    }
  );

  app.get("/spaces", { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    const { rows } = await db.query<SpaceRow>(
      `SELECT s.id, s.subject_name, s.subject_birth_year, s.subject_death_year,
              s.created_at, m.role
         FROM spaces s
         JOIN memberships m ON m.space_id = s.id
        WHERE m.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT ${LIST_LIMIT}`,
      [userId]
    );
    return reply.code(200).send({ spaces: rows });
  });

  app.get("/spaces/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      return reply.code(404).send({ error: copy.notFound });
    }
    const userId = req.user!.id;

    const member = await db.query<SpaceRow>(
      `SELECT s.id, s.subject_name, s.subject_birth_year, s.subject_death_year,
              s.created_at, m.role
         FROM spaces s
         JOIN memberships m ON m.space_id = s.id
        WHERE s.id = $1 AND m.user_id = $2`,
      [id, userId]
    );
    if (member.rows.length > 0) {
      return reply.code(200).send(member.rows[0]);
    }

    const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [id]);
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: copy.notFound });
    }
    return reply.code(403).send({ error: copy.forbidden });
  });
}
