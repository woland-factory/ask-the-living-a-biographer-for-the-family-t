import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";
import type { ChatFn } from "../src/lib/llm.js";

// Fake model seam. The suggestions prompt is told it "helps a family group
// their tellings"; everything else is a cross-telling comparison.
let questionReply = "What did the kitchen smell like on those mornings?";
let labelReply = "The bakery on Sunday mornings";
const chat: ChatFn = async ({ messages }) => {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("group their tellings")) return labelReply;
  return questionReply;
};

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

async function recordTelling(
  ctx: TestContext,
  cookie: string,
  spaceId: string,
  transcript: string,
  key = "everyday-ordinary-day"
): Promise<string> {
  const sessionId = await startSession(ctx, cookie, spaceId);
  const created = await ctx.app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/answers`,
    headers: { cookie },
    payload: {
      bank_question_key: key,
      prompt_text: "What did an ordinary day look like?",
      topic: "everyday",
      duration_ms: 2000,
    },
  });
  const answerId = created.json().id;
  await ctx.app.inject({
    method: "PATCH",
    url: `/answers/${answerId}`,
    headers: { cookie },
    payload: { transcript_status: "done", transcript },
  });
  return answerId;
}

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

async function createStory(ctx: TestContext, cookie: string, spaceId: string, label: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/spaces/${spaceId}/stories`,
    headers: { cookie },
    payload: { label },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function tag(
  ctx: TestContext,
  cookie: string,
  answerId: string,
  storyId: string | null
) {
  return ctx.app.inject({
    method: "POST",
    url: `/answers/${answerId}/story`,
    headers: { cookie },
    payload: { story_id: storyId },
  });
}

const GRANTED = "story-org@example.com";

describe("stories with a key (the signature moment)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp(
      {
        llmGatewayUrl: "https://gateway.example/v1",
        llmApiKey: "gw-key",
        llmGatewayModel: "claude-haiku",
        llmGatewayAllowEmails: [GRANTED],
      },
      { llm: { chat } }
    );
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("poses one gentle cross-question per teller and renders both side by side", async () => {
    questionReply = "What did the kitchen smell like on those mornings?";
    const org = await signIn(ctx.app, GRANTED);
    const spaceId = await createSpace(ctx, org, "Rosa Martel");
    const orgAnswer = await recordTelling(
      ctx,
      org,
      spaceId,
      "She sang in the kitchen while the bread baked."
    );
    const guest = await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Elena",
      relationship_to_subject: "sister",
    });
    const guestAnswer = await recordTelling(
      ctx,
      guest,
      spaceId,
      "She opened before dawn and saved the first loaf for a neighbor.",
      "everyday-mornings"
    );

    const storyId = await createStory(ctx, org, spaceId, "The bakery on Sunday mornings");

    // One teller so far: nothing to compare.
    const first = await tag(ctx, org, orgAnswer, storyId);
    expect(first.statusCode).toBe(200);
    expect(first.json().generated).toBe(0);

    // The organizer aligns the second teller. Now the moment generates.
    const second = await tag(ctx, org, guestAnswer, storyId);
    expect(second.statusCode).toBe(200);
    expect(second.json().generated).toBe(2);

    const rows = await ctx.db.query<{
      origin: string;
      membership_id: string;
      parent_answer_id: string;
    }>(
      "SELECT origin, membership_id, parent_answer_id FROM questions WHERE story_id = $1 AND origin = 'crosstelling'",
      [storyId]
    );
    expect(rows.rows).toHaveLength(2);
    // Each question points at the OTHER teller's telling.
    const orgMember = (
      await ctx.db.query<{ id: string }>(
        "SELECT membership_id AS id FROM answers WHERE id = $1",
        [orgAnswer]
      )
    ).rows[0].id;
    const guestMember = (
      await ctx.db.query<{ id: string }>(
        "SELECT membership_id AS id FROM answers WHERE id = $1",
        [guestAnswer]
      )
    ).rows[0].id;
    const toOrg = rows.rows.find((r) => r.membership_id === orgMember)!;
    const toGuest = rows.rows.find((r) => r.membership_id === guestMember)!;
    expect(toOrg.parent_answer_id).toBe(guestAnswer);
    expect(toGuest.parent_answer_id).toBe(orgAnswer);

    // The side-by-side surface: two verbatim tellings, each with its question.
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: org },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.tellings).toHaveLength(2);
    for (const t of body.tellings) {
      expect(t.open_question).not.toBeNull();
      expect(typeof t.answers[0].transcript).toBe("string");
    }
    // No merged/summary anywhere.
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("merged");
    expect(JSON.stringify(body)).not.toContain("\"combined\"");

    // Re-triggering does not duplicate (partial unique index).
    const again = await tag(ctx, org, guestAnswer, storyId);
    expect(again.json().generated).toBe(0);
    const after = await ctx.db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM questions WHERE story_id = $1 AND origin = 'crosstelling'",
      [storyId]
    );
    expect(Number(after.rows[0].n)).toBe(2);
  });

  it("serves the cross-telling question into the teller's next sitting with origin", async () => {
    questionReply = "What did their garden look like in summer?";
    const granted = await signIn(ctx.app, GRANTED);
    const spaceId2 = await createSpace(ctx, granted, "Grace Bello");
    const a1 = await recordTelling(ctx, granted, spaceId2, "He kept bees behind the shed.");
    const guest = await inviteAndJoin(ctx, granted, spaceId2, {
      display_name: "Tom",
      relationship_to_subject: "brother",
    });
    const a2 = await recordTelling(ctx, guest, spaceId2, "He sold the honey at the market.", "everyday-mornings");
    const storyId = await createStory(ctx, granted, spaceId2, "The bees");
    await tag(ctx, granted, a1, storyId);
    await tag(ctx, granted, a2, storyId);

    // The guest opens a fresh sitting and is served the cross-telling question.
    const sessionId = await startSession(ctx, guest, spaceId2);
    const session = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie: guest },
    });
    const cross = session
      .json()
      .followups.find((f: { origin: string }) => f.origin === "crosstelling");
    expect(cross).toBeTruthy();
    expect(cross.routed).toBe(false);

    // Answering it via question_id flips it to answered.
    const created = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie: guest },
      payload: {
        bank_question_key: `crosstelling:${cross.id}`,
        prompt_text: cross.text,
        topic: cross.topic,
        duration_ms: 1500,
        question_id: cross.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const status = await ctx.db.query<{ status: string }>(
      "SELECT status FROM questions WHERE id = $1",
      [cross.id]
    );
    expect(status.rows[0].status).toBe("answered");
  });

  it("suggests an existing story and proposes a new label, without tagging", async () => {
    const org = await signIn(ctx.app, GRANTED);
    const spaceId = await createSpace(ctx, org, "Clara Innes");
    const answer = await recordTelling(ctx, org, spaceId, "We went to the lake every August.");
    const storyId = await createStory(ctx, org, spaceId, "The summer at the lake");

    // The model matches an existing label.
    labelReply = "The summer at the lake";
    const match = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answer}/story-suggestions`,
      headers: { cookie: org },
    });
    expect(match.statusCode).toBe(200);
    expect(match.json().mode).toBe("gateway");
    expect(match.json().suggestions).toEqual([
      { story_id: storyId, label: "The summer at the lake" },
    ]);
    expect(match.json().suggested_label).toBeNull();

    // The model proposes a brand new label.
    labelReply = "Fishing off the dock";
    const fresh = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answer}/story-suggestions`,
      headers: { cookie: org },
    });
    expect(fresh.json().suggestions).toEqual([]);
    expect(fresh.json().suggested_label).toBe("Fishing off the dock");

    // Nothing was tagged by either call.
    const still = await ctx.db.query<{ story_id: string | null }>(
      "SELECT story_id FROM answers WHERE id = $1",
      [answer]
    );
    expect(still.rows[0].story_id).toBeNull();
  });
});

describe("stories with no key (manual grouping still works)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("groups two tellings and renders them side by side with generated 0", async () => {
    const org = await signIn(ctx.app, "nokey-org@example.com");
    const spaceId = await createSpace(ctx, org, "Rosa Martel");
    const a1 = await recordTelling(ctx, org, spaceId, "She sang in the kitchen every morning.");
    const guest = await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Elena",
      relationship_to_subject: "sister",
    });
    const a2 = await recordTelling(ctx, guest, spaceId, "She opened the shop before dawn.", "everyday-mornings");
    const storyId = await createStory(ctx, org, spaceId, "The bakery");

    await tag(ctx, org, a1, storyId);
    const res = await tag(ctx, org, a2, storyId);
    expect(res.json().generated).toBe(0);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: org },
    });
    const body = detail.json();
    expect(body.tellings).toHaveLength(2);
    for (const t of body.tellings) expect(t.open_question).toBeNull();

    // The list marks the story ready with two tellers.
    const list = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories`,
      headers: { cookie: org },
    });
    const story = list.json().stories.find((s: { id: string }) => s.id === storyId);
    expect(story.teller_count).toBe(2);
    expect(story.ready).toBe(true);

    // Suggestions with no key fall back cleanly to the manual picker.
    const suggest = await ctx.app.inject({
      method: "POST",
      url: `/answers/${a1}/story-suggestions`,
      headers: { cookie: org },
    });
    expect(suggest.json()).toEqual({ mode: "off", suggestions: [], suggested_label: null });
  });
});

describe("story privacy (no reveal before alignment)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("gates the side-by-side and audio until the viewer has their own telling", async () => {
    const org = await signIn(ctx.app, "priv-org@example.com");
    const spaceId = await createSpace(ctx, org, "Rosa Martel");
    const storyId = await createStory(ctx, org, spaceId, "The bakery");

    const alice = await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Alice",
      relationship_to_subject: "daughter",
    });
    const aliceAnswer = await recordTelling(ctx, alice, spaceId, "She sang in the kitchen.");
    await tag(ctx, org, aliceAnswer, storyId);

    const bob = await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Bob",
      relationship_to_subject: "son",
    });
    const bobAnswer = await recordTelling(ctx, bob, spaceId, "He fixed the ovens.", "everyday-mornings");

    // Bob has no telling in the story yet: the wall stays up.
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: bob },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("This story opens once you've added your own telling.");

    const deniedAudio = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}/audio/${aliceAnswer}`,
      headers: { cookie: bob },
    });
    expect(deniedAudio.statusCode).toBe(403);

    // The organizer sees the story without a telling of their own.
    const orgView = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: org },
    });
    expect(orgView.statusCode).toBe(200);

    // Once Bob aligns his own telling, the story opens for him.
    await tag(ctx, bob, bobAnswer, storyId);
    const allowed = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: bob },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("never returns another member's transcript from GET /tellings", async () => {
    const org = await signIn(ctx.app, "priv-org2@example.com");
    const spaceId = await createSpace(ctx, org, "Grace Bello");
    const secret = "A private telling only Alice recorded.";
    const alice = await inviteAndJoin(ctx, org, spaceId, {
      display_name: "Alice",
      relationship_to_subject: "daughter",
    });
    await recordTelling(ctx, alice, spaceId, secret);
    await recordTelling(ctx, org, spaceId, "The organizer's own telling.");

    // The organizer sees every member's grouping metadata, but no transcript.
    const asOrg = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/tellings`,
      headers: { cookie: org },
    });
    const orgBody = asOrg.json();
    expect(orgBody.tellings.length).toBeGreaterThanOrEqual(2);
    for (const t of orgBody.tellings) expect(t).not.toHaveProperty("transcript");
    expect(JSON.stringify(orgBody)).not.toContain(secret);

    // A non-organizer sees only their own tellings.
    const asAlice = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/tellings`,
      headers: { cookie: alice },
    });
    const aliceBody = asAlice.json();
    expect(aliceBody.tellings.every((t: { is_own: boolean }) => t.is_own)).toBe(true);
  });

  it("guards non-members and unknown ids", async () => {
    const org = await signIn(ctx.app, "priv-org3@example.com");
    const spaceId = await createSpace(ctx, org, "Held Person");
    const storyId = await createStory(ctx, org, spaceId, "A story");

    const stranger = await signIn(ctx.app, "priv-stranger@example.com");
    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/${storyId}`,
      headers: { cookie: stranger },
    });
    expect(forbidden.statusCode).toBe(403);

    const unknownStory = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/stories/11111111-1111-1111-1111-111111111111`,
      headers: { cookie: org },
    });
    expect(unknownStory.statusCode).toBe(404);
  });
});
