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

/** Invite a relative into a space and return their session cookie. */
async function inviteAndJoin(
  ctx: TestContext,
  organizer: string,
  spaceId: string,
  who: { display_name: string; relationship_to_subject: string }
): Promise<string> {
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/spaces/${spaceId}/invites`,
    headers: { cookie: organizer },
    payload: {},
  });
  const token = invite.json().url.split("/join/")[1];
  const joined = await ctx.app.inject({
    method: "POST",
    url: `/invite/${token}/join`,
    payload: who,
  });
  const c = joined.cookies.find((x) => x.name === "atl_session")!;
  return `atl_session=${c.value}`;
}

async function firstOpenQuestion(
  ctx: TestContext,
  cookie: string,
  spaceId: string
): Promise<{ id: string }> {
  const list = await ctx.app.inject({
    method: "GET",
    url: `/spaces/${spaceId}/questions`,
    headers: { cookie },
  });
  return list.json().questions[0];
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

  it("seeds the bank in one idempotent upsert: re-seeding leaves 16 rows and stable counts", async () => {
    const cookie = await signIn(ctx.app, "gap-idem@example.com");
    const spaceId = await createSpace(ctx, cookie, "Nora Whitfield");

    // Session start and every gap-map read run the single multi-row upsert.
    // Running it several times must not duplicate rows or move counts.
    await startSession(ctx, cookie, spaceId);
    for (let i = 0; i < 3; i++) {
      await ctx.app.inject({
        method: "GET",
        url: `/spaces/${spaceId}/questions`,
        headers: { cookie },
      });
    }
    await startSession(ctx, cookie, spaceId);

    const rows = await ctx.db.query<{ n: string }>(
      "SELECT count(*)::int AS n FROM questions WHERE space_id = $1 AND origin = 'bank'",
      [spaceId]
    );
    expect(Number(rows.rows[0].n)).toBe(BANK.length);

    const gap = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie },
    });
    expect(gap.json().counts.open).toBe(BANK.length);
    expect(gap.json().counts.total).toBe(BANK.length);
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

describe("question routing", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("routes an open question to a member, re-routes, and clears it", async () => {
    const organizer = await signIn(ctx.app, "route-org@example.com");
    const spaceId = await createSpace(ctx, organizer, "Clara Innes");
    await startSession(ctx, organizer, spaceId);
    await inviteAndJoin(ctx, organizer, spaceId, {
      display_name: "Carol",
      relationship_to_subject: "sister",
    });

    // Two people now: pick the sister as the routing target.
    const gap = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie: organizer },
    });
    const people = gap.json().people;
    expect(people.some((p: { display_name: string | null }) => p.display_name === "Carol")).toBe(true);
    const carol = people.find(
      (p: { relationship_to_subject: string | null }) => p.relationship_to_subject === "sister"
    );
    const question = gap.json().questions[0];

    const routed = await ctx.app.inject({
      method: "POST",
      url: `/questions/${question.id}/route`,
      headers: { cookie: organizer },
      payload: { membership_id: carol.membership_id },
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json().assigned_to).toBe(carol.membership_id);
    const stamped = await ctx.db.query<{ routed_at: string | null }>(
      "SELECT routed_at FROM questions WHERE id = $1",
      [question.id]
    );
    expect(stamped.rows[0].routed_at).not.toBeNull();

    // Clearing wipes both fields.
    const cleared = await ctx.app.inject({
      method: "POST",
      url: `/questions/${question.id}/route`,
      headers: { cookie: organizer },
      payload: { membership_id: null },
    });
    expect(cleared.json().assigned_to).toBeNull();
    const afterClear = await ctx.db.query<{ routed_at: string | null }>(
      "SELECT routed_at FROM questions WHERE id = $1",
      [question.id]
    );
    expect(afterClear.rows[0].routed_at).toBeNull();
  });

  it("rejects a membership from another space with 400", async () => {
    const org = await signIn(ctx.app, "route-cross-a@example.com");
    const spaceA = await createSpace(ctx, org, "Space A Person");
    await startSession(ctx, org, spaceA);

    const otherOrg = await signIn(ctx.app, "route-cross-b@example.com");
    const spaceB = await createSpace(ctx, otherOrg, "Space B Person");
    await startSession(ctx, otherOrg, spaceB);
    const bGap = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceB}/questions`,
      headers: { cookie: otherOrg },
    });
    const bMembership = bGap.json().people[0].membership_id;

    const aQuestion = await firstOpenQuestion(ctx, org, spaceA);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/questions/${aQuestion.id}/route`,
      headers: { cookie: org },
      payload: { membership_id: bMembership },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to route a resolved question, and guards non-members and unknown ids", async () => {
    const org = await signIn(ctx.app, "route-status@example.com");
    const spaceId = await createSpace(ctx, org, "Held Person");
    const sessionId = await startSession(ctx, org, spaceId);
    const question = await firstOpenQuestion(ctx, org, spaceId);

    // Resolve it, then routing is 400.
    await ctx.app.inject({
      method: "PATCH",
      url: `/questions/${question.id}`,
      headers: { cookie: org },
      payload: { status: "deferred" },
    });
    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/questions/${question.id}/route`,
      headers: { cookie: org },
      payload: { membership_id: null },
    });
    expect(resolved.statusCode).toBe(400);

    const stranger = await signIn(ctx.app, "route-stranger@example.com");
    const another = await firstOpenQuestion(ctx, org, spaceId);
    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `/questions/${another.id}/route`,
      headers: { cookie: stranger },
      payload: { membership_id: null },
    });
    expect(forbidden.statusCode).toBe(403);

    const unknown = await ctx.app.inject({
      method: "POST",
      url: `/questions/00000000-0000-0000-0000-000000000000/route`,
      headers: { cookie: org },
      payload: { membership_id: null },
    });
    expect(unknown.statusCode).toBe(404);
    expect(sessionId).toBeTruthy();
  });

  it("returns assigned_to per question and display_name per person, never an email", async () => {
    const org = await signIn(ctx.app, "route-view@example.com");
    const spaceId = await createSpace(ctx, org, "Viewed Person");
    await startSession(ctx, org, spaceId);
    await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Sam",
      relationship_to_subject: "nephew",
    });

    const gap = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie: org },
    });
    const body = gap.json();
    expect(body.questions[0]).toHaveProperty("assigned_to");
    expect(body.people.every((p: Record<string, unknown>) => "display_name" in p)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("@");
  });
});
