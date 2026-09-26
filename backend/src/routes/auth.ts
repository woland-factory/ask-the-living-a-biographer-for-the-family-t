import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { generateToken, normalizeEmail, sha256Hex } from "../lib/crypto.js";
import { sendMagicLink } from "../lib/mailer.js";
import { FixedWindowLimiter } from "../lib/rate-window.js";
import {
  clearSessionCookie,
  makeRequireAuth,
  setSessionCookie,
} from "../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AuthDeps {
  db: Db;
  config: AppConfig;
  /** Records the latest link per email so the e2e suite can complete sign-in. */
  e2eLinks?: Map<string, string>;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, config, e2eLinks } = deps;
  const requireAuth = makeRequireAuth(db);

  // Per-email dimension of the magic-link limit (plugin covers per-IP).
  const emailLimiter = new FixedWindowLimiter(5, 15 * 60 * 1000);

  app.post(
    "/auth/magic-link",
    {
      config: {
        // Two dimensions: a strict per-email cap (below) plus a broader
        // per-IP cap here to blunt spraying across many addresses.
        rateLimit: {
          max: 50,
          timeWindow: "15 minutes",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { email: string };
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email)) {
        return reply.code(400).send({ error: copy.validation });
      }
      if (!emailLimiter.take(email)) {
        return reply.code(429).send({ error: copy.rateLimit });
      }

      const rawToken = generateToken();
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + config.magicLinkTtlMin * 60_000);
      await db.query(
        `INSERT INTO magic_link_tokens (email, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [email, tokenHash, expiresAt.toISOString()]
      );

      const base =
        config.publicBaseUrl ||
        `${req.protocol}://${req.headers.host ?? "localhost"}`;
      const verifyUrl = `${base.replace(/\/$/, "")}/auth/verify?token=${rawToken}`;

      const delivered = await sendMagicLink({
        email,
        url: verifyUrl,
        config,
        log: {
          info: (m) => req.log.info(m),
          warn: (m) => req.log.warn(m),
        },
        onLocalLink: (e, url) => e2eLinks?.set(e, url),
      });

      // An outage looks the same for every address, so this leaks nothing about
      // whether the email is known. Don't pretend a link is on its way.
      if (!delivered) {
        return reply.code(503).send({ error: copy.mailUnavailable });
      }

      // Always the same answer, whether or not the email is known.
      return reply.code(200).send({ ok: true });
    }
  );

  app.get(
    "/auth/verify",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", minLength: 8, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const { token } = req.query as { token: string };
      const tokenHash = sha256Hex(token);

      // Atomic single-use: only an unexpired, unconsumed token flips to consumed.
      const consumed = await db.query<{ email: string }>(
        `UPDATE magic_link_tokens
            SET consumed_at = now()
          WHERE token_hash = $1
            AND consumed_at IS NULL
            AND expires_at > now()
        RETURNING email`,
        [tokenHash]
      );
      if (consumed.rows.length === 0) {
        return reply.redirect("/signin?e=expired");
      }
      const email = consumed.rows[0].email;

      const existing = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );
      let userId: string;
      if (existing.rows.length > 0) {
        userId = existing.rows[0].id;
      } else {
        const created = await db.query<{ id: string }>(
          "INSERT INTO users (email) VALUES ($1) RETURNING id",
          [email]
        );
        userId = created.rows[0].id;
      }

      const sessionExpires = new Date(
        Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000
      );
      const session = await db.query<{ id: string }>(
        "INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id",
        [userId, sessionExpires.toISOString()]
      );

      setSessionCookie(reply, req, session.rows[0].id, config);
      return reply.redirect("/");
    }
  );

  app.get("/me", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    return reply.code(200).send({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    });
  });

  app.post(
    "/auth/logout",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (req.sessionId) {
        await db.query("DELETE FROM auth_sessions WHERE id = $1", [
          req.sessionId,
        ]);
      }
      clearSessionCookie(reply);
      return reply.code(204).send();
    }
  );

  // Test-only affordance: enabled only under E2E so Playwright can read the
  // link the Mailer stub would have sent. Never mounted in production.
  if (config.isE2E && e2eLinks) {
    app.get("/auth/dev/last-link", async (req, reply) => {
      const email = normalizeEmail(String((req.query as { email?: string }).email ?? ""));
      const url = e2eLinks.get(email);
      if (!url) return reply.code(404).send({ error: copy.notFound });
      return reply.code(200).send({ url });
    });
  }
}
