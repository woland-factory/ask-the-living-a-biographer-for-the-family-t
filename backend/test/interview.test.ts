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
