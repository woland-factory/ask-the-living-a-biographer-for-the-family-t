import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  assertSafeOutboundUrl,
  chat,
  gatewayEligible,
  resolveLlmAccess,
} from "../src/lib/llm.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { runMigrations } from "../src/db/migrate.js";
import { encryptSecret } from "../src/lib/crypto.js";
import type { SessionUser } from "../src/lib/session.js";

function config(overrides: Record<string, unknown> = {}) {
  return { ...loadConfig(), ...overrides };
}

describe("assertSafeOutboundUrl", () => {
  it("accepts a normal https URL", () => {
    expect(() => assertSafeOutboundUrl("https://api.openai.com/v1")).not.toThrow();
  });

  it("rejects http on a non-local host", () => {
    expect(() => assertSafeOutboundUrl("http://api.openai.com/v1")).toThrow();
  });

  it("rejects loopback, private, and link-local IPs", () => {
    for (const u of [
      "https://127.0.0.1/v1",
      "https://10.0.0.5/v1",
      "https://172.16.4.9/v1",
      "https://192.168.1.10/v1",
      "https://169.254.1.1/v1",
      "https://[::1]/v1",
    ]) {
      expect(() => assertSafeOutboundUrl(u), u).toThrow();
    }
  });

  it("rejects the cloud metadata IP", () => {
    expect(() => assertSafeOutboundUrl("https://169.254.169.254/latest")).toThrow();
  });

  it("rejects internal hostnames", () => {
    for (const u of [
      "https://central-mailer-prod-api/send",
      "https://something.internal/v1",
      "https://db.local/v1",
      "https://foo-prod-api/v1",
    ]) {
      expect(() => assertSafeOutboundUrl(u), u).toThrow();
    }
  });

  it("allows http to localhost only outside production", () => {
    expect(() =>
      assertSafeOutboundUrl("http://127.0.0.1:1234/v1", { isProduction: false })
    ).not.toThrow();
    expect(() =>
      assertSafeOutboundUrl("http://127.0.0.1:1234/v1", { isProduction: true })
    ).toThrow();
  });
});

describe("gatewayEligible", () => {
  const user: SessionUser = { id: "u", email: "Grace@Example.com", display_name: null };

  it("is false for a non-listed user", () => {
    expect(gatewayEligible(user, config({ llmGatewayAllowEmails: [] }))).toBe(false);
    expect(
      gatewayEligible(user, config({ llmGatewayAllowEmails: ["someone@else.com"] }))
    ).toBe(false);
  });

  it("is true only for an allow-listed email (case-insensitive)", () => {
    expect(
      gatewayEligible(user, config({ llmGatewayAllowEmails: ["grace@example.com"] }))
    ).toBe(true);
  });
});

describe("resolveLlmAccess", () => {
  it("returns byok when a credential row exists", async () => {
    const db = await createPgliteDb();
    await runMigrations(db);
    const u = await db.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('a@example.com') RETURNING id"
    );
    const userId = u.rows[0].id;
    const cfg = config({ llmCredSecret: "material-xyz" });
    const sealed = encryptSecret("sk-user-key", cfg.llmCredSecret);
    await db.query(
      `INSERT INTO llm_credentials
         (user_id, base_url, model, key_ciphertext, key_iv, key_tag, key_last4)
       VALUES ($1,'https://api.openai.com/v1','gpt-4o-mini',$2,$3,$4,'-key')`,
      [userId, sealed.ciphertext, sealed.iv, sealed.tag]
    );
    const user: SessionUser = { id: userId, email: "a@example.com", display_name: null };
    const access = await resolveLlmAccess(db, user, cfg);
    expect(access.mode).toBe("byok");
    expect(access.apiKey).toBe("sk-user-key");
    expect(access.baseUrl).toBe("https://api.openai.com/v1");
    await db.close();
  });

  it("returns gateway for an allow-listed user with no BYOK when env is present", async () => {
    const db = await createPgliteDb();
    await runMigrations(db);
    const u = await db.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('grant@example.com') RETURNING id"
    );
    const user: SessionUser = {
      id: u.rows[0].id,
      email: "grant@example.com",
      display_name: null,
    };
    const cfg = config({
      llmGatewayUrl: "https://gateway.example/v1",
      llmApiKey: "gw-key",
      llmGatewayModel: "claude-haiku",
      llmGatewayAllowEmails: ["grant@example.com"],
    });
    const access = await resolveLlmAccess(db, user, cfg);
    expect(access.mode).toBe("gateway");
    expect(access.apiKey).toBe("gw-key");
    expect(access.model).toBe("claude-haiku");
    await db.close();
  });

  it("returns off for an ordinary user with no key and no grant", async () => {
    const db = await createPgliteDb();
    await runMigrations(db);
    const u = await db.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('plain@example.com') RETURNING id"
    );
    const user: SessionUser = {
      id: u.rows[0].id,
      email: "plain@example.com",
      display_name: null,
    };
    const cfg = config({
      llmGatewayUrl: "https://gateway.example/v1",
      llmApiKey: "gw-key",
      llmGatewayAllowEmails: [],
    });
    const access = await resolveLlmAccess(db, user, cfg);
    expect(access.mode).toBe("off");
    await db.close();
  });
});

describe("chat error scrubbing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never leaks the key or the full path on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    let message = "";
    try {
      await chat({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-super-secret-key",
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("sk-super-secret-key");
    expect(message).not.toContain("/chat/completions");
    expect(message).toContain("api.openai.com");
  });

  it("never leaks the key on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom sk-super-secret-key");
      })
    );
    let message = "";
    try {
      await chat({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-super-secret-key",
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("sk-super-secret-key");
    expect(message).toContain("api.openai.com");
  });
});
