import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";
import { BANK } from "../src/interview/bank.js";

async function createSpace(ctx: TestContext, cookie: string, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/spaces",
    headers: { cookie },
    payload: { subject_name: name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function startSession(ctx: TestContext, cookie: string, spaceId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/spaces/${spaceId}/sessions`,
    headers: { cookie },
  });
  expect([200, 201]).toContain(res.statusCode);
  return res.json().id;
}

describe("gap map questions", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("seeds the bank as open questions and reports stable counts", async () => {
    const cookie = await signIn(ctx.app, "gap-a@example.com");
    const spaceId = await createSpace(ctx, cookie, "Margaret Ellison");
    await startSession(ctx, cookie, spaceId);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.questions).toHaveLength(BANK.length);
    expect(body.counts.open).toBe(BANK.length);
    expect(body.counts.total).toBe(BANK.length);
    expect(body.questions.every((q: { status: string }) => q.status === "open")).toBe(true);
    expect(body.topics.length).toBeGreaterThan(0);
    expect(body.people.length).toBeGreaterThan(0);
  });

  it("moves status with PATCH, sets and clears resolved_at, and shrinks the open count", async () => {
    const cookie = await signIn(ctx.app, "gap-b@example.com");
    const spaceId = await createSpace(ctx, cookie, "Henry Okafor");
    await startSession(ctx, cookie, spaceId);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie },
    });
    const first = list.json().questions[0];

    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/questions/${first.id}`,
      headers: { cookie },
      payload: { status: "deferred" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("deferred");

    const after = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie },
    });
    expect(after.json().counts.open).toBe(BANK.length - 1);
    expect(after.json().counts.deferred).toBe(1);

    // Reopening clears resolved_at and restores the open count.
    const reopened = await ctx.app.inject({
      method: "PATCH",
      url: `/questions/${first.id}`,
      headers: { cookie },
      payload: { status: "open" },
    });
    expect(reopened.json().status).toBe("open");
    const row = await ctx.db.query<{ resolved_at: string | null }>(
      "SELECT resolved_at FROM questions WHERE id = $1",
      [first.id]
    );
    expect(row.rows[0].resolved_at).toBeNull();
  });

  it("filters by topic and by person while counts stay unfiltered", async () => {
    const cookie = await signIn(ctx.app, "gap-c@example.com");
    const spaceId = await createSpace(ctx, cookie, "Rosa Martel");
    await startSession(ctx, cookie, spaceId);

    // Filter by a known topic returns only that topic's questions.
    const byTopic = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions?topic=beginnings`,
      headers: { cookie },
    });
    const beginnings = BANK.filter((b) => b.topic === "beginnings").length;
    expect(byTopic.json().questions).toHaveLength(beginnings);
    // Counts stay whole-space even under a filter.
    expect(byTopic.json().counts.open).toBe(BANK.length);

    // Bank questions belong to no one, so "anyone" returns them all.
    const anyone = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions?membership_id=anyone`,
      headers: { cookie },
    });
    expect(anyone.json().questions).toHaveLength(BANK.length);

    // A specific person filter returns that person's follow-ups only.
    const membershipId = anyone.json().people[0].membership_id;
    await ctx.db.query(
      `INSERT INTO questions (space_id, membership_id, origin, topic, text, status)
       VALUES ($1, $2, 'followup', 'everyday', 'What did his mornings look like?', 'open')`,
      [spaceId, membershipId]
    );
    const byPerson = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions?membership_id=${membershipId}`,
      headers: { cookie },
    });
    expect(byPerson.json().questions).toHaveLength(1);
    expect(byPerson.json().questions[0].origin).toBe("followup");
  });

  it("answering a bank question flips its row to answered", async () => {
    const cookie = await signIn(ctx.app, "gap-d@example.com");
    const spaceId = await createSpace(ctx, cookie, "Alice Brenner");
    const sessionId = await startSession(ctx, cookie, spaceId);

    const bankQ = BANK[0];
    const created = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: bankQ.key,
        prompt_text: bankQ.text,
        topic: bankQ.topic,
        duration_ms: 1000,
      },
    });
    expect(created.statusCode).toBe(201);

    const row = await ctx.db.query<{ status: string }>(
      "SELECT status FROM questions WHERE space_id = $1 AND bank_question_key = $2 AND origin = 'bank'",
      [spaceId, bankQ.key]
    );
    expect(row.rows[0].status).toBe("answered");
  });

  it("rejects an unknown filter value with 400", async () => {
    const cookie = await signIn(ctx.app, "gap-e@example.com");
    const spaceId = await createSpace(ctx, cookie, "Sam Vale");
    await startSession(ctx, cookie, spaceId);
    for (const url of [
      `/spaces/${spaceId}/questions?status=bogus`,
      `/spaces/${spaceId}/questions?topic=nope`,
      `/spaces/${spaceId}/questions?membership_id=not-a-uuid`,
    ]) {
      const res = await ctx.app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("forbids a non-member and 404s an unknown space", async () => {
    const ownerCookie = await signIn(ctx.app, "gap-owner@example.com");
    const spaceId = await createSpace(ctx, ownerCookie, "Private Person");
    await startSession(ctx, ownerCookie, spaceId);

    const strangerCookie = await signIn(ctx.app, "gap-stranger@example.com");
    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie: strangerCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await ctx.app.inject({
      method: "GET",
      url: `/spaces/11111111-1111-1111-1111-111111111111/questions`,
      headers: { cookie: strangerCookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
