import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";

describe("spaces", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("rejects an unauthenticated create with 401", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      payload: { subject_name: "Nobody" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a space with an organizer membership and lists it", async () => {
    const cookie = await signIn(ctx.app, "organizer@example.com");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: "Margaret Ellison", subject_birth_year: 1949, subject_death_year: 2026 },
    });
    expect(create.statusCode).toBe(201);
    const space = create.json();
    expect(space.subject_name).toBe("Margaret Ellison");
    expect(space.subject_birth_year).toBe(1949);

    const memberships = await ctx.db.query<{ role: string }>(
      "SELECT role FROM memberships WHERE space_id = $1",
      [space.id]
    );
    expect(memberships.rows).toHaveLength(1);
    expect(memberships.rows[0].role).toBe("organizer");

    const list = await ctx.app.inject({
      method: "GET",
      url: "/spaces",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().spaces.map((s: { id: string }) => s.id);
    expect(ids).toContain(space.id);
  });

  it("returns a space to its member and 403 to a non-member", async () => {
    const ownerCookie = await signIn(ctx.app, "owner@example.com");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie: ownerCookie },
      payload: { subject_name: "Private Person" },
    });
    const spaceId = create.json().id;

    const asMember = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}`,
      headers: { cookie: ownerCookie },
    });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().subject_name).toBe("Private Person");

    const outsiderCookie = await signIn(ctx.app, "outsider@example.com");
    const asOutsider = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}`,
      headers: { cookie: outsiderCookie },
    });
    expect(asOutsider.statusCode).toBe(403);
  });

  it("returns 404 for a well-formed but nonexistent space id", async () => {
    const cookie = await signIn(ctx.app, "curious@example.com");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/spaces/00000000-0000-0000-0000-000000000000",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an oversized subject name with 400, not 500", async () => {
    const cookie = await signIn(ctx.app, "long@example.com");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: "x".repeat(200) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});
