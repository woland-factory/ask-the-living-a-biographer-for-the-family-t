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
});
