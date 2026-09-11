import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { isUuid } from "./crypto.js";
import { copy } from "./copy.js";

export const SESSION_COOKIE = "atl_session";

export interface SessionUser {
  id: string;
  email: string;
  display_name: string | null;
}

/** Derive the cookie Secure flag from the request/URL scheme, never from NODE_ENV. */
export function isSecureRequest(req: FastifyRequest, config: AppConfig): boolean {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  if (forwarded) return forwarded === "https";
  if (config.publicBaseUrl) return config.publicBaseUrl.startsWith("https://");
  return req.protocol === "https";
}

export function setSessionCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  sessionId: string,
  config: AppConfig
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req, config),
    path: "/",
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Resolve the session cookie to a user, or null if absent/invalid/expired. */
export async function resolveSession(
  req: FastifyRequest,
  db: Db
): Promise<{ user: SessionUser; sessionId: string } | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value || !isUuid(unsigned.value)) return null;

  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    email: string;
    display_name: string | null;
    expires_at: string;
  }>(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, u.email, u.display_name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [unsigned.value]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, display_name: row.display_name },
  };
}

/**
 * preHandler that requires a valid session. Attaches req.user / req.sessionId
 * or answers 401. Server-side authorization for every non-public route.
 */
export function makeRequireAuth(db: Db) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const session = await resolveSession(req, db);
    if (!session) {
      reply.code(401).send({ error: copy.unauthorized });
      return reply;
    }
    req.user = session.user;
    req.sessionId = session.sessionId;
  };
}
