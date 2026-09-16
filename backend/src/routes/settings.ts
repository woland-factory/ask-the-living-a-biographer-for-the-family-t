import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { copy } from "../lib/copy.js";
import { encryptSecret } from "../lib/crypto.js";
import { makeRequireAuth } from "../lib/session.js";
import { assertSafeOutboundUrl, gatewayEligible } from "../lib/llm.js";

interface CredRow {
  base_url: string;
  model: string;
  provider_label: string | null;
  key_last4: string;
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: AppConfig }
): void {
  const { db, config } = deps;
  const requireAuth = makeRequireAuth(db);
  const mutate = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  const gatewayAvailable = (user: {
    id: string;
    email: string | null;
    display_name: string | null;
  }) => Boolean(config.llmGatewayUrl && config.llmApiKey && gatewayEligible(user, config));

  // A guest joined by invite has no email, so no place to manage a key. Deny
  // every credential route server-side, not just by hiding the button.
  const denyGuest = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.user!.email === null) {
      reply.code(403).send({ error: copy.forbidden });
      return true;
    }
    return false;
  };

  // The user's own credential, redacted. The full key is never returned.
  app.get("/me/llm-credential", { preHandler: requireAuth }, async (req, reply) => {
    if (denyGuest(req, reply)) return reply;
    const user = req.user!;
    const { rows } = await db.query<CredRow>(
      `SELECT base_url, model, provider_label, key_last4
         FROM llm_credentials WHERE user_id = $1`,
      [user.id]
    );
    if (rows.length === 0) {
      return reply.code(200).send({ configured: false, gateway_available: gatewayAvailable(user) });
    }
    const row = rows[0];
    return reply.code(200).send({
      configured: true,
      provider_label: row.provider_label,
      base_url: row.base_url,
      model: row.model,
      key_last4: row.key_last4,
      gateway_available: gatewayAvailable(user),
    });
  });

  // Store or replace the user's own key. Encrypted at rest; never echoed back.
  app.put(
    "/me/llm-credential",
    {
      preHandler: requireAuth,
      config: mutate,
      schema: {
        body: {
          type: "object",
          required: ["base_url", "api_key"],
          additionalProperties: false,
          properties: {
            base_url: { type: "string", minLength: 1, maxLength: 2000 },
            api_key: { type: "string", minLength: 1, maxLength: 500 },
            model: { type: "string", minLength: 1, maxLength: 100 },
            provider_label: { type: "string", minLength: 0, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (denyGuest(req, reply)) return reply;
      const user = req.user!;
      const body = req.body as {
        base_url: string;
        api_key: string;
        model?: string;
        provider_label?: string;
      };
      const baseUrl = body.base_url.trim();
      try {
        assertSafeOutboundUrl(baseUrl, { isProduction: config.isProduction });
      } catch {
        return reply.code(400).send({ error: copy.validation });
      }

      const model = (body.model ?? "gpt-4o-mini").trim() || "gpt-4o-mini";
      const providerLabel = (body.provider_label ?? "").trim() || null;
      const apiKey = body.api_key;
      const last4 = apiKey.slice(-4);
      const sealed = encryptSecret(apiKey, config.llmCredSecret);

      await db.query(
        `INSERT INTO llm_credentials
           (user_id, base_url, model, provider_label, key_ciphertext, key_iv, key_tag, key_last4, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (user_id) DO UPDATE SET
           base_url = EXCLUDED.base_url,
           model = EXCLUDED.model,
           provider_label = EXCLUDED.provider_label,
           key_ciphertext = EXCLUDED.key_ciphertext,
           key_iv = EXCLUDED.key_iv,
           key_tag = EXCLUDED.key_tag,
           key_last4 = EXCLUDED.key_last4,
           updated_at = now()`,
        [user.id, baseUrl, model, providerLabel, sealed.ciphertext, sealed.iv, sealed.tag, last4]
      );

      return reply.code(200).send({
        configured: true,
        provider_label: providerLabel,
        base_url: baseUrl,
        model,
        key_last4: last4,
        gateway_available: gatewayAvailable(user),
      });
    }
  );

  // Remove the key. Idempotent: 204 whether or not a row existed.
  app.delete(
    "/me/llm-credential",
    { preHandler: requireAuth, config: mutate },
    async (req, reply) => {
      if (denyGuest(req, reply)) return reply;
      await db.query("DELETE FROM llm_credentials WHERE user_id = $1", [req.user!.id]);
      return reply.code(204).send();
    }
  );
}
