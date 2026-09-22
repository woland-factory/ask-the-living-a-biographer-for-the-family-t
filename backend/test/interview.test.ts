import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { runMigrations } from "../src/db/migrate.js";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";

async function createSpace(ctx: TestContext, cookie: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/spaces",
    headers: { cookie },
    payload: { subject_name: "Margaret Ellison" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe("interview loop", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  it("requires auth to start a session", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/spaces/00000000-0000-0000-0000-000000000000/sessions",
    });
    expect(res.statusCode).toBe(401);
  });

  it("start returns an open session and a second start resumes the same one", async () => {
    const cookie = await signIn(ctx.app, "starter@example.com");
    const spaceId = await createSpace(ctx, cookie);

    const first = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(201);
    const sessionId = first.json().id;
    expect(first.json().space_id).toBe(spaceId);
    expect(first.json().ended_at).toBeNull();

    const second = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(sessionId);
  });

  it("blocks a non-member and 404s an unknown space", async () => {
    const owner = await signIn(ctx.app, "owner2@example.com");
    const spaceId = await createSpace(ctx, owner);

    const outsider = await signIn(ctx.app, "outsider2@example.com");
    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie: outsider },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await ctx.app.inject({
      method: "POST",
      url: "/spaces/00000000-0000-0000-0000-000000000000/sessions",
      headers: { cookie: outsider },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /sessions/:id returns progress and caps unknown/forbidden", async () => {
    const cookie = await signIn(ctx.app, "progress@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;

    const get = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.answered_keys).toEqual([]);
    expect(body.deferred_topics).toEqual([]);
    expect(body.answers).toEqual([]);
    // The open-follow-ups list is a bounded array (LIMIT), same shape as before.
    expect(Array.isArray(body.followups)).toBe(true);
    expect(body.followups.length).toBeLessThanOrEqual(50);

    const unknown = await ctx.app.inject({
      method: "GET",
      url: "/sessions/00000000-0000-0000-0000-000000000000",
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);

    const outsider = await signIn(ctx.app, "peeker@example.com");
    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie: outsider },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("validates answer creation at the boundary", async () => {
    const cookie = await signIn(ctx.app, "answerer@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;

    const missingFields = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: { bank_question_key: "beginnings-hometown" },
    });
    expect(missingFields.statusCode).toBe(400);

    const oversize = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "beginnings-hometown",
        prompt_text: "Where did they grow up?",
        topic: "beginnings",
        duration_ms: 5_000_000,
      },
    });
    expect(oversize.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "beginnings-hometown",
        prompt_text: "Where did they grow up?",
        topic: "beginnings",
        duration_ms: 4200,
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().transcript_status).toBe("pending");
  });

  it("stores and returns audio byte-for-byte with its mime", async () => {
    const cookie = await signIn(ctx.app, "audio@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "beginnings-hometown",
        prompt_text: "Where did they grow up?",
        topic: "beginnings",
        duration_ms: 4200,
      },
    });
    const answerId = answer.json().id;

    const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/webm`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload,
    });
    expect(put.statusCode).toBe(204);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/answers/${answerId}/audio`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toContain("audio/webm");
    expect(get.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(get.rawPayload)).toEqual(payload);
  });

  it("rejects a disallowed mime and blocks cross-family audio reads", async () => {
    const cookie = await signIn(ctx.app, "mime@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "family-how-they-met",
        prompt_text: "How did they meet?",
        topic: "family",
        duration_ms: 3000,
      },
    });
    const answerId = answer.json().id;

    const badMime = await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=application/zip`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(badMime.statusCode).toBe(400);

    await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/webm`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3]),
    });

    const outsider = await signIn(ctx.app, "nosy@example.com");
    const blocked = await ctx.app.inject({
      method: "GET",
      url: `/answers/${answerId}/audio`,
      headers: { cookie: outsider },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("attaches a transcript and records failure without touching audio", async () => {
    const cookie = await signIn(ctx.app, "transcript@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "everyday-cooking",
        prompt_text: "What did they cook?",
        topic: "everyday",
        duration_ms: 5000,
      },
    });
    const answerId = answer.json().id;
    await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/webm`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from([9, 8, 7, 6]),
    });

    const noText = await ctx.app.inject({
      method: "PATCH",
      url: `/answers/${answerId}`,
      headers: { cookie },
      payload: { transcript_status: "done" },
    });
    expect(noText.statusCode).toBe(400);

    const done = await ctx.app.inject({
      method: "PATCH",
      url: `/answers/${answerId}`,
      headers: { cookie },
      payload: { transcript_status: "done", transcript: "She made soup on Sundays." },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().transcript_status).toBe("done");
    expect(done.json().transcript).toBe("She made soup on Sundays.");

    const failed = await ctx.app.inject({
      method: "PATCH",
      url: `/answers/${answerId}`,
      headers: { cookie },
      payload: { transcript_status: "failed" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().transcript_status).toBe("failed");
    expect(failed.json().transcript).toBeNull();

    // Audio survived both transitions.
    const audio = await ctx.app.inject({
      method: "GET",
      url: `/answers/${answerId}/audio`,
      headers: { cookie },
    });
    expect(audio.statusCode).toBe(200);
    expect(Buffer.from(audio.rawPayload)).toEqual(Buffer.from([9, 8, 7, 6]));
  });

  it("defers a topic idempotently and reflects it in progress", async () => {
    const cookie = await signIn(ctx.app, "defer@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;

    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/sessions/${sessionId}/defer`,
        headers: { cookie },
        payload: { topic: "beginnings" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }

    const get = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(get.json().deferred_topics).toEqual(["beginnings"]);
  });

  it("completes a sitting and is idempotent", async () => {
    const cookie = await signIn(ctx.app, "complete@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;
    await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "keeping-never-forget",
        prompt_text: "What do you never want to forget?",
        topic: "keeping",
        duration_ms: 6000,
      },
    });

    const first = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/complete`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().ended_at).toBeTruthy();
    expect(first.json().answered_count).toBe(1);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/complete`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    // ended_at does not move on a second complete.
    expect(second.json().ended_at).toBe(first.json().ended_at);
  });

  it("rejects an oversize audio body with 413, never 500", async () => {
    const cookie = await signIn(ctx.app, "big@example.com");
    const spaceId = await createSpace(ctx, cookie);
    const start = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = start.json().id;
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "work-their-days",
        prompt_text: "What work filled their days?",
        topic: "work",
        duration_ms: 6000,
      },
    });
    const answerId = answer.json().id;

    const tooBig = Buffer.alloc(13 * 1024 * 1024, 1);
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/webm`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: tooBig,
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("routing and sitting privacy across two members", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.close();
  });

  async function newSpace(cookie: string, name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: name },
    });
    return res.json().id;
  }
  async function joinAs(
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
  async function startSession(cookie: string, spaceId: string): Promise<string> {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    return res.json().id;
  }

  it("a routed question appears first for the target, not for the other member, and resolves on answer", async () => {
    const organizer = await signIn(ctx.app, "carry-org@example.com");
    const spaceId = await newSpace(organizer, "Delia Munro");
    const orgSession = await startSession(organizer, spaceId);
    const relative = await joinAs(organizer, spaceId, {
      display_name: "Carol",
      relationship_to_subject: "sister",
    });
    const relSession = await startSession(relative, spaceId);

    // Find the relative's membership and route a bank question to her.
    const gap = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie: organizer },
    });
    const carol = gap.json().people.find(
      (p: { relationship_to_subject: string | null }) => p.relationship_to_subject === "sister"
    );
    const question = gap.json().questions[0];
    const openBefore = gap.json().counts.open;

    const routed = await ctx.app.inject({
      method: "POST",
      url: `/questions/${question.id}/route`,
      headers: { cookie: organizer },
      payload: { membership_id: carol.membership_id },
    });
    expect(routed.statusCode).toBe(200);

    // The relative's sitting offers it first, flagged routed.
    const relProgress = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${relSession}`,
      headers: { cookie: relative },
    });
    const relFollowups = relProgress.json().followups;
    expect(relFollowups[0].id).toBe(question.id);
    expect(relFollowups[0].routed).toBe(true);

    // The organizer's own sitting does not carry it.
    const orgProgress = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${orgSession}`,
      headers: { cookie: organizer },
    });
    expect(
      orgProgress.json().followups.some((f: { id: string }) => f.id === question.id)
    ).toBe(false);

    // The relative answers it with question_id; it flips to answered and the
    // shared open count drops.
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${relSession}/answers`,
      headers: { cookie: relative },
      payload: {
        bank_question_key: `routed:${question.id}`,
        prompt_text: question.text,
        topic: question.topic,
        duration_ms: 3000,
        question_id: question.id,
      },
    });
    expect(answer.statusCode).toBe(201);

    const row = await ctx.db.query<{ status: string; resolved_at: string | null }>(
      "SELECT status, resolved_at FROM questions WHERE id = $1",
      [question.id]
    );
    expect(row.rows[0].status).toBe("answered");
    expect(row.rows[0].resolved_at).not.toBeNull();

    const gapAfter = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie: organizer },
    });
    expect(gapAfter.json().counts.open).toBe(openBefore - 1);
  });

  it("a follow-up routed away leaves its teller's queue", async () => {
    const organizer = await signIn(ctx.app, "carry-away-org@example.com");
    const spaceId = await newSpace(organizer, "Elias Wray");
    const orgSession = await startSession(organizer, spaceId);
    const relative = await joinAs(organizer, spaceId, {
      display_name: "Sam",
      relationship_to_subject: "nephew",
    });
    const relSession = await startSession(relative, spaceId);

    // The organizer's own follow-up.
    const orgMembership = await ctx.db.query<{ id: string }>(
      `SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 AND u.email = 'carry-away-org@example.com'`,
      [spaceId]
    );
    const follow = await ctx.db.query<{ id: string }>(
      `INSERT INTO questions (space_id, membership_id, origin, topic, text, status)
       VALUES ($1, $2, 'followup', 'everyday', 'What were his mornings like?', 'open')
       RETURNING id`,
      [spaceId, orgMembership.rows[0].id]
    );
    const followId = follow.rows[0].id;

    // Before routing, it is in the organizer's queue.
    const before = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${orgSession}`,
      headers: { cookie: organizer },
    });
    expect(before.json().followups.some((f: { id: string }) => f.id === followId)).toBe(true);

    const relMembership = await ctx.db.query<{ id: string }>(
      `SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 AND u.display_name = 'Sam'`,
      [spaceId]
    );
    await ctx.app.inject({
      method: "POST",
      url: `/questions/${followId}/route`,
      headers: { cookie: organizer },
      payload: { membership_id: relMembership.rows[0].id },
    });

    // Now it left the organizer's queue and joined the relative's.
    const after = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${orgSession}`,
      headers: { cookie: organizer },
    });
    expect(after.json().followups.some((f: { id: string }) => f.id === followId)).toBe(false);
    const rel = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${relSession}`,
      headers: { cookie: relative },
    });
    expect(rel.json().followups.some((f: { id: string }) => f.id === followId)).toBe(true);
  });

  it("member B cannot read or touch member A's sitting or audio", async () => {
    const memberA = await signIn(ctx.app, "priv-a@example.com");
    const spaceId = await newSpace(memberA, "Frida Sol");
    const sessionA = await startSession(memberA, spaceId);
    const memberB = await joinAs(memberA, spaceId, {
      display_name: "Bea",
      relationship_to_subject: "cousin",
    });

    // A records an answer with audio.
    const answer = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionA}/answers`,
      headers: { cookie: memberA },
      payload: {
        bank_question_key: "beginnings-hometown",
        prompt_text: "Where did they grow up?",
        topic: "beginnings",
        duration_ms: 3000,
      },
    });
    const answerId = answer.json().id;
    await ctx.app.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/webm`,
      headers: { cookie: memberA, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    // Every session/answer route is 403 for B, with the private-sitting message.
    const cookieB = { cookie: memberB };
    const octet = { cookie: memberB, "content-type": "application/octet-stream" };
    const cases: [string, string, Record<string, string>, unknown?][] = [
      ["GET", `/sessions/${sessionA}`, cookieB],
      ["POST", `/sessions/${sessionA}/answers`, cookieB, {
        bank_question_key: "x",
        prompt_text: "x",
        topic: "x",
        duration_ms: 100,
      }],
      ["POST", `/sessions/${sessionA}/defer`, cookieB, { topic: "beginnings" }],
      ["POST", `/sessions/${sessionA}/complete`, cookieB],
      ["GET", `/answers/${answerId}/audio`, cookieB],
      ["PUT", `/answers/${answerId}/audio?mime=audio/webm`, octet, Buffer.from([9])],
      ["PATCH", `/answers/${answerId}`, cookieB, { transcript_status: "failed" }],
      ["POST", `/answers/${answerId}/followups`, cookieB],
    ];
    for (const [method, url, headers, payload] of cases) {
      const res = await ctx.app.inject({ method: method as never, url, headers, payload: payload as never });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error, `${method} ${url}`).toBe("Each sitting stays private to its teller.");
    }

    // A's own flows still work.
    const own = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionA}`,
      headers: { cookie: memberA },
    });
    expect(own.statusCode).toBe(200);
    const ownAudio = await ctx.app.inject({
      method: "GET",
      url: `/answers/${answerId}/audio`,
      headers: { cookie: memberA },
    });
    expect(ownAudio.statusCode).toBe(200);
  });
});

describe("audio persists across a fresh app instance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atl-audio-persist-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps stored audio readable after reconnecting to the same database", async () => {
    const bytes = Buffer.from([42, 43, 44, 45, 46, 47]);

    const db1 = await createPgliteDb(dir);
    await runMigrations(db1);
    const app1 = await buildApp({
      db: db1,
      config: {
        isE2E: true,
        isProduction: false,
        sessionSecret: "audio-persist-secret-for-signing-cookies-123456",
        publicBaseUrl: "http://127.0.0.1",
      },
    });
    await app1.ready();
    const cookie = await signIn(app1, "durable-audio@example.com");
    const space = await app1.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: "Durable Voice" },
    });
    const spaceId = space.json().id;
    const session = await app1.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = session.json().id;
    const answer = await app1.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "together-a-day-you-keep",
        prompt_text: "Tell me about a day with them.",
        topic: "together",
        duration_ms: 7000,
      },
    });
    const answerId = answer.json().id;
    await app1.inject({
      method: "PUT",
      url: `/answers/${answerId}/audio?mime=audio/ogg`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: bytes,
    });
    await app1.close();
    await db1.close();

    const db2 = await createPgliteDb(dir);
    await runMigrations(db2);
    const app2 = await buildApp({
      db: db2,
      config: {
        isE2E: true,
        isProduction: false,
        sessionSecret: "audio-persist-secret-for-signing-cookies-123456",
        publicBaseUrl: "http://127.0.0.1",
      },
    });
    await app2.ready();
    const cookie2 = await signIn(app2, "durable-audio@example.com");
    const audio = await app2.inject({
      method: "GET",
      url: `/answers/${answerId}/audio`,
      headers: { cookie: cookie2 },
    });
    expect(audio.statusCode).toBe(200);
    expect(Buffer.from(audio.rawPayload)).toEqual(bytes);
    await app2.close();
    await db2.close();
  });
});
