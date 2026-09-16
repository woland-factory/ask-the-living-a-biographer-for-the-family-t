import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SessionUser } from "./session.js";
import { decryptSecret } from "./crypto.js";

export type LlmMode = "byok" | "gateway" | "off";

export interface LlmAccess {
  mode: LlmMode;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ChatFn = (args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<string>;

interface CredentialRow {
  base_url: string;
  model: string;
  key_ciphertext: string;
  key_iv: string;
  key_tag: string;
}

/**
 * Who may use the owner-granted gateway tier by allow-listed email. EPIC 3:
 * a user whose email the owner listed in LLM_GATEWAY_ALLOW_EMAILS. This is the
 * "explicitly validated by the owner" path. It must never default to true for
 * an anonymous or ordinary signed-in user; a guest (null email) is never on it.
 *
 * The invited-user path lives in resolveLlmAccess (see joinedByInvite): a
 * relative who joined by link counts as owner-validated. Widen access THERE,
 * never by loosening this default.
 */
export function gatewayEligible(user: SessionUser, config: AppConfig): boolean {
  const email = (user.email ?? "").trim().toLowerCase();
  return email.length > 0 && config.llmGatewayAllowEmails.includes(email);
}

/** True when the user joined a space by invite link. Their membership carries an
 * invite_id, which is the "owner-validated" marker for the gateway tier. */
export async function joinedByInvite(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND invite_id IS NOT NULL LIMIT 1",
    [userId]
  );
  return rows.length > 0;
}

/**
 * Resolve which LLM path this user gets, in strict priority:
 *   1. BYOK    - the user saved their own credential row.
 *   2. Gateway - no BYOK, gateway env present, and the user is owner-granted.
 *   3. Off     - otherwise. The feature is simply off; never a funded default.
 */
export async function resolveLlmAccess(
  db: Db,
  user: SessionUser,
  config: AppConfig
): Promise<LlmAccess> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT base_url, model, key_ciphertext, key_iv, key_tag
       FROM llm_credentials WHERE user_id = $1`,
    [user.id]
  );
  if (rows.length > 0) {
    const row = rows[0];
    const apiKey = decryptSecret(
      { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
      config.llmCredSecret
    );
    return { mode: "byok", baseUrl: row.base_url, apiKey, model: row.model };
  }

  const gatewayGranted =
    gatewayEligible(user, config) || (await joinedByInvite(db, user.id));
  if (config.llmGatewayUrl && config.llmApiKey && gatewayGranted) {
    return {
      mode: "gateway",
      baseUrl: config.llmGatewayUrl,
      apiKey: config.llmApiKey,
      model: config.llmGatewayModel,
    };
  }

  return { mode: "off", baseUrl: "", apiKey: "", model: "" };
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. metadata IP)
  return false;
}

/**
 * Guard a user-controlled outbound base URL against SSRF. Called at credential
 * store time and before every call. Throws on anything unsafe.
 *
 * Known residual risk: DNS rebinding (a hostname that resolves to a private IP
 * at call time) is not fully closed here. Out of scope for this EPIC.
 */
export function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { isProduction?: boolean } = {}
): void {
  const isProduction = opts.isProduction ?? true; // strict by default
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The endpoint address is not a valid URL.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Local dev escape hatch: localhost over http/https only outside production.
  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  if (!isProduction && isLocalHost && (url.protocol === "http:" || url.protocol === "https:")) {
    return;
  }

  if (url.protocol !== "https:") {
    throw new Error("The endpoint must use https.");
  }

  if (host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("That endpoint address is not allowed.");
  }
  if (host === "central-mailer-prod-api" || host.includes("-prod-")) {
    throw new Error("That endpoint address is not allowed.");
  }
  if (host === "::1" || host === "localhost") {
    throw new Error("That endpoint address is not allowed.");
  }
  if (isPrivateIpv4(host)) {
    throw new Error("That endpoint address is not allowed.");
  }
}

/** The host shown in a scrubbed error, never the full URL or path. */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "the model endpoint";
  }
}

/**
 * The real transport: an OpenAI-compatible chat completion. Short timeout, no
 * retries. On any failure it throws an error whose message carries neither the
 * key nor the full URL, only the host and status. Callers treat a throw as
 * "no follow-up this time".
 */
export const chat: ChatFn = async ({
  baseUrl,
  apiKey,
  model,
  messages,
  timeoutMs,
  signal,
}) => {
  assertSafeOutboundUrl(baseUrl, { isProduction: process.env.NODE_ENV === "production" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 120,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new Error(`Could not reach ${safeHost(baseUrl)}.`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`${safeHost(baseUrl)} returned status ${res.status}.`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${safeHost(baseUrl)} sent an unreadable reply.`);
  }
  const text = (data as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error(`${safeHost(baseUrl)} sent an unexpected reply.`);
  }
  return text;
};
