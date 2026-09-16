import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { generateToken, isUuid, sha256Hex } from "../lib/crypto.js";
import {
  makeRequireAuth,
  resolveSession,
  setSessionCookie,
} from "../lib/session.js";

// An invite lives for two weeks. There is no product reason to tune this per
// deployment, so it stays a code constant rather than an env var or config.
const INVITE_TTL_DAYS = 14;
const INVITE_LIST_LIMIT = 100;

interface InviteDeps {
  db: Db;
  config: AppConfig;
}

/** Confirm the caller is the organizer of a space. Mirrors GET /spaces/:id:
 * unknown space -> 404, non-member -> 403, contributor -> 403. */
async function requireOrganizer(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  spaceId: string
): Promise<boolean> {
  if (!isUuid(spaceId)) {
    reply.code(404).send({ error: copy.notFound });
    return false;
  }
  const { rows } = await db.query<{ role: string }>(
    "SELECT role FROM memberships WHERE space_id = $1 AND user_id = $2",
    [spaceId, req.user!.id]
  );
  if (rows.length === 0) {
    const exists = await db.query("SELECT 1 FROM spaces WHERE id = $1", [spaceId]);
    if (exists.rows.length === 0) reply.code(404).send({ error: copy.notFound });
    else reply.code(403).send({ error: copy.forbidden });
    return false;
  }
  if (rows[0].role !== "organizer") {
    reply.code(403).send({ error: copy.forbidden });
    return false;
  }
  return true;
}

function inviteBaseUrl(req: FastifyRequest, config: AppConfig): string {
  const base =
    config.publicBaseUrl ||
    `${req.protocol}://${req.headers.host ?? "localhost"}`;
  return base.replace(/\/$/, "");
}

export function registerInviteRoutes(app: FastifyInstance, deps: InviteDeps): void {
  const { db, config } = deps;
  const requireAuth = makeRequireAuth(db);

  // Create a single-use, expiring invite link for one relative. Organizer only.
  app.post(
    "/spaces/:id/invites",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 0, maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await requireOrganizer(db, req, reply, id))) return reply;

      const body = (req.body ?? {}) as { label?: string };
      const label = (body.label ?? "").trim() || null;

      const rawToken = generateToken();
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(
        Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
      );

      const created = await db.query<{
        id: string;
        label: string | null;
        status: string;
        expires_at: string;
        created_at: string;
      }>(
        `INSERT INTO invites (space_id, created_by, label, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, label, status, expires_at, created_at`,
        [id, req.user!.id, label, tokenHash, expiresAt.toISOString()]
      );
      const row = created.rows[0];

      // The full URL is returned exactly once. Only the hash is stored.
      return reply.code(201).send({
        id: row.id,
        url: `${inviteBaseUrl(req, config)}/join/${rawToken}`,
        label: row.label,
        status: row.status,
        expires_at: row.expires_at,
        created_at: row.created_at,
      });
    }
  );

  // The space's invites, newest first. Organizer only. Never a token or email.
  app.get(
    "/spaces/:id/invites",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await requireOrganizer(db, req, reply, id))) return reply;

      const { rows } = await db.query<{
        id: string;
        label: string | null;
        status: string;
        expires_at: string;
        created_at: string;
        expired: boolean;
        joined_display_name: string | null;
        joined_relationship: string | null;
      }>(
        `SELECT i.id, i.label, i.status, i.expires_at, i.created_at,
                (i.status = 'pending' AND i.expires_at <= now()) AS expired,
                u.display_name AS joined_display_name,
                m.relationship_to_subject AS joined_relationship
           FROM invites i
           LEFT JOIN memberships m ON m.invite_id = i.id
           LEFT JOIN users u ON u.id = m.user_id
          WHERE i.space_id = $1
          ORDER BY i.created_at DESC
          LIMIT ${INVITE_LIST_LIMIT}`,
        [id]
      );

      const invites = rows.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status === "joined" ? "joined" : r.expired ? "expired" : "pending",
        expires_at: r.expires_at,
        created_at: r.created_at,
        joined:
          r.status === "joined"
            ? {
                display_name: r.joined_display_name,
                relationship_to_subject: r.joined_relationship,
              }
            : null,
      }));

      return reply.code(200).send({ invites });
    }
  );

  // Public preview for the join page. Never consumes the token.
  app.get(
    "/invite/:token",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 20, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const tokenHash = sha256Hex(token);

      const { rows } = await db.query<{
        status: string;
        expired: boolean;
        subject_name: string;
      }>(
        `SELECT i.status,
                (i.expires_at <= now()) AS expired,
                s.subject_name
           FROM invites i
           JOIN spaces s ON s.id = i.space_id
          WHERE i.token_hash = $1`,
        [tokenHash]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: copy.notFound });
      }
      const row = rows[0];
      if (row.status === "joined") {
        return reply.code(200).send({ status: "used" });
      }
      if (row.expired) {
        return reply.code(200).send({ status: "expired" });
      }
      return reply.code(200).send({ status: "ready", subject_name: row.subject_name });
    }
  );

  // Join by link. Public: no auth required, an existing session is honored.
  app.post(
    "/invite/:token/join",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 20, maxLength: 200 },
          },
        },
        body: {
          type: "object",
          required: ["display_name", "relationship_to_subject"],
          additionalProperties: false,
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 80 },
            relationship_to_subject: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = req.body as {
        display_name: string;
        relationship_to_subject: string;
      };
      const displayName = body.display_name.trim();
      const relationship = body.relationship_to_subject.trim();
      if (displayName.length === 0 || relationship.length === 0) {
        return reply.code(400).send({ error: copy.validation });
      }

      const tokenHash = sha256Hex(token);
      const session = await resolveSession(req, db);

      // A curious organizer opening their own link must not burn it: an existing
      // member of the invite's space rejoins to the same space without consuming.
      if (session) {
        const invite = await db.query<{ space_id: string }>(
          "SELECT space_id FROM invites WHERE token_hash = $1",
          [tokenHash]
        );
        if (invite.rows.length > 0) {
          const spaceId = invite.rows[0].space_id;
          const member = await db.query(
            "SELECT 1 FROM memberships WHERE space_id = $1 AND user_id = $2",
            [spaceId, session.user.id]
          );
          if (member.rows.length > 0) {
            return reply.code(200).send({ space_id: spaceId, already_member: true });
          }
        }
      }

      const sessionExpires = new Date(
        Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000
      );

      // Consume and create atomically. A failure after the UPDATE rolls the
      // whole transaction back, so the token is never spent without a join.
      const result = await db.transaction(async (tx) => {
        const consumed = await tx.query<{ id: string; space_id: string }>(
          `UPDATE invites SET status = 'joined', joined_at = now()
            WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
          RETURNING id, space_id`,
          [tokenHash]
        );
        if (consumed.rows.length === 0) return null;
        const invite = consumed.rows[0];

        let userId: string;
        if (session) {
          userId = session.user.id;
        } else {
          const createdUser = await tx.query<{ id: string }>(
            "INSERT INTO users (email, display_name) VALUES (NULL, $1) RETURNING id",
            [displayName]
          );
          userId = createdUser.rows[0].id;
        }

        await tx.query(
          `INSERT INTO memberships (space_id, user_id, relationship_to_subject, role, invite_id)
           VALUES ($1, $2, $3, 'contributor', $4)`,
          [invite.space_id, userId, relationship, invite.id]
        );

        let sessionId: string | null = null;
        if (!session) {
          const created = await tx.query<{ id: string }>(
            "INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id",
            [userId, sessionExpires.toISOString()]
          );
          sessionId = created.rows[0].id;
        }
        return { space_id: invite.space_id, sessionId };
      });

      if (!result) return reply.code(410).send({ error: copy.inviteGone });
      if (result.sessionId) {
        setSessionCookie(reply, req, result.sessionId, config);
      }
      return reply.code(201).send({ space_id: result.space_id });
    }
  );
}
