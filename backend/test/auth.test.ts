import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";
import { normalizeEmail } from "../src/lib/crypto.js";

describe("magic-link auth", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("returns 200 for a known and an unknown email alike (no enumeration)", async () => {
    const a = await ctx.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "known@example.com" },
    });
    const b = await ctx.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "stranger@example.com" },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ ok: true });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ ok: true });
  });

  it("stores only a hash of the token, never the raw token", async () => {
    const email = "hash@example.com";
    await ctx.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email },
    });
    const url = ctx.app.e2eLinks!.get(email)!;
    const rawToken = new URL(url).searchParams.get("token")!;

    const { rows } = await ctx.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM magic_link_tokens WHERE email = $1",
      [email]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).not.toContain(rawToken);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects a malformed email with 400 and a safe message", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect(JSON.stringify(res.json())).not.toContain("Error:");
  });

  it("rate-limits repeated requests for one email with a product-voice 429", async () => {
    const email = "flood@example.com";
    let last = 200;
    for (let i = 0; i < 8; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/magic-link",
        payload: { email },
      });
      last = res.statusCode;
      if (last === 429) {
        expect(res.json().error).toContain("going a little fast");
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("signs in on the happy path and resolves /me", async () => {
    const cookie = await signIn(ctx.app, "happy@example.com");
    const me = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("happy@example.com");
  });

  it("rejects an expired token", async () => {
    // Build an app with a zero-minute TTL so the token is already expired.
    const short = await makeTestApp({ magicLinkTtlMin: -1 });
    await short.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "expired@example.com" },
    });
    const url = short.app.e2eLinks!.get("expired@example.com")!;
    const token = new URL(url).searchParams.get("token")!;
    const verify = await short.app.inject({
      method: "GET",
      url: `/auth/verify?token=${encodeURIComponent(token)}`,
    });
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toContain("/signin?e=expired");
    await short.app.close();
    await short.db.close();
  });

  it("rejects a reused token (single-use)", async () => {
    const email = "reuse@example.com";
    await ctx.app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email },
    });
    const url = ctx.app.e2eLinks!.get(normalizeEmail(email))!;
    const token = new URL(url).searchParams.get("token")!;

    const first = await ctx.app.inject({
      method: "GET",
      url: `/auth/verify?token=${encodeURIComponent(token)}`,
    });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/");

    const second = await ctx.app.inject({
      method: "GET",
      url: `/auth/verify?token=${encodeURIComponent(token)}`,
    });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toContain("/signin?e=expired");
  });

  it("returns 401 from /me without a cookie", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("logout clears the session so /me is 401 again", async () => {
    const cookie = await signIn(ctx.app, "logout@example.com");
    const out = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });
    expect(out.statusCode).toBe(204);
    const me = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });
});
