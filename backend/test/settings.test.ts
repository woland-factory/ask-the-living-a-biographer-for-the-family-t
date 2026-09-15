import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";
import { decryptSecret } from "../src/lib/crypto.js";

const SECRET = "test-cred-secret-material-abcdefghijklmno";

describe("llm credential settings", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp({ llmCredSecret: SECRET });
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("requires auth on every route", async () => {
    const get = await ctx.app.inject({ method: "GET", url: "/me/llm-credential" });
    expect(get.statusCode).toBe(401);
    const del = await ctx.app.inject({ method: "DELETE", url: "/me/llm-credential" });
    expect(del.statusCode).toBe(401);
    // A valid body clears schema validation, so the auth preHandler answers.
    const put = await ctx.app.inject({
      method: "PUT",
      url: "/me/llm-credential",
      payload: { base_url: "https://api.openai.com/v1", api_key: "sk-x" },
    });
    expect(put.statusCode).toBe(401);
  });

  it("reports not configured before a key is set", async () => {
    const cookie = await signIn(ctx.app, "cred-none@example.com");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/me/llm-credential",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.gateway_available).toBe(false);
    expect(body.key_last4).toBeUndefined();
  });

  it("stores an encrypted key, returns a redacted view, and never echoes the key", async () => {
    const email = "cred-set@example.com";
    const cookie = await signIn(ctx.app, email);
    const apiKey = "sk-live-supersecret-9999";
    const put = await ctx.app.inject({
      method: "PUT",
      url: "/me/llm-credential",
      headers: { cookie },
      payload: {
        base_url: "https://api.openai.com/v1",
        api_key: apiKey,
        model: "gpt-4o-mini",
        provider_label: "OpenAI",
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.configured).toBe(true);
    expect(body.key_last4).toBe("9999");
    expect(JSON.stringify(body)).not.toContain(apiKey);

    // The raw DB row holds ciphertext, not the plaintext key.
    const u = await ctx.db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    const row = await ctx.db.query<{
      key_ciphertext: string;
      key_iv: string;
      key_tag: string;
      key_last4: string;
    }>(
      "SELECT key_ciphertext, key_iv, key_tag, key_last4 FROM llm_credentials WHERE user_id = $1",
      [u.rows[0].id]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].key_ciphertext).not.toContain(apiKey);
    expect(row.rows[0].key_last4).toBe("9999");
    expect(
      decryptSecret(
        {
          ciphertext: row.rows[0].key_ciphertext,
          iv: row.rows[0].key_iv,
          tag: row.rows[0].key_tag,
        },
        SECRET
      )
    ).toBe(apiKey);

    // GET now shows the redacted view with no full key.
    const get = await ctx.app.inject({
      method: "GET",
      url: "/me/llm-credential",
      headers: { cookie },
    });
    const g = get.json();
    expect(g.configured).toBe(true);
    expect(g.key_last4).toBe("9999");
    expect(JSON.stringify(g)).not.toContain(apiKey);
  });

  it("rejects a disallowed base URL with 400", async () => {
    const cookie = await signIn(ctx.app, "cred-bad@example.com");
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/me/llm-credential",
      headers: { cookie },
      payload: { base_url: "https://169.254.169.254/v1", api_key: "sk-x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("removes the key and is idempotent", async () => {
    const cookie = await signIn(ctx.app, "cred-del@example.com");
    await ctx.app.inject({
      method: "PUT",
      url: "/me/llm-credential",
      headers: { cookie },
      payload: { base_url: "https://api.openai.com/v1", api_key: "sk-del-1234" },
    });
    const first = await ctx.app.inject({
      method: "DELETE",
      url: "/me/llm-credential",
      headers: { cookie },
    });
    expect(first.statusCode).toBe(204);
    const second = await ctx.app.inject({
      method: "DELETE",
      url: "/me/llm-credential",
      headers: { cookie },
    });
    expect(second.statusCode).toBe(204);

    const get = await ctx.app.inject({
      method: "GET",
      url: "/me/llm-credential",
      headers: { cookie },
    });
    expect(get.json().configured).toBe(false);
  });

  it("tells an allow-listed user the gateway is available without a key", async () => {
    const email = "granted@example.com";
    const gw = await makeTestApp({
      llmGatewayUrl: "https://gateway.example/v1",
      llmApiKey: "gw-key",
      llmGatewayAllowEmails: [email],
    });
    try {
      const cookie = await signIn(gw.app, email);
      const res = await gw.app.inject({
        method: "GET",
        url: "/me/llm-credential",
        headers: { cookie },
      });
      expect(res.json().gateway_available).toBe(true);
    } finally {
      await gw.app.close();
      await gw.db.close();
    }
  });
});
