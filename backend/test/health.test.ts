import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestContext } from "./helpers.js";

describe("GET /healthz", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("returns 200 ok when the DB is reachable", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  // Rate limiting is per route on mutations/auth, not global: serving the SPA
  // shell must never 429, or a page load (many asset hits) and shared-proxy
  // families would be throttled on normal browsing.
  it("does not rate-limit the SPA shell across many page loads", async () => {
    for (let i = 0; i < 350; i++) {
      const res = await ctx.app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
    }
  });
});
