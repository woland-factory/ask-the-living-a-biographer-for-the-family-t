import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestContext } from "./helpers.js";
import { seedDemo, DEMO } from "../src/seed.js";

describe("GET /demo/story", () => {
  it("returns 404 before the demo family is seeded", async () => {
    const ctx = await makeTestApp();
    const res = await ctx.app.inject({ method: "GET", url: "/demo/story" });
    expect(res.statusCode).toBe(404);
    await ctx.app.close();
    await ctx.db.close();
  });

  describe("after seeding", () => {
    let ctx: TestContext;
    beforeAll(async () => {
      ctx = await makeTestApp();
      await seedDemo(ctx.db, { info: () => undefined });
    });
    afterAll(async () => {
      await ctx.app.close();
      await ctx.db.close();
    });

    it("serves the side-by-side moment with no cookie, transcript-only", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/demo/story" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.story.label).toBe(DEMO.storyLabel);
      expect(body.tellings).toHaveLength(2);

      // Two distinct, verbatim tellings, each with its open question. No audio.
      const transcripts = body.tellings.map(
        (t: { answers: { transcript: string }[] }) => t.answers[0].transcript
      );
      expect(transcripts).toContain(DEMO.daughter.transcript);
      expect(transcripts).toContain(DEMO.sister.transcript);
      for (const t of body.tellings) {
        expect(t.open_question).not.toBeNull();
        expect(t.answers[0].audio_url).toBeNull();
      }
      // Never a merged or summary field.
      expect(body).not.toHaveProperty("summary");
      expect(body).not.toHaveProperty("merged");
    });

    it("exposes only the demo space, never a real family", async () => {
      // The route looks up the demo by its reserved organizer email marker.
      const res = await ctx.app.inject({ method: "GET", url: "/demo/story" });
      const body = res.json();
      expect(JSON.stringify(body)).not.toContain("@");
      expect(body.story.label).toBe(DEMO.storyLabel);
    });
  });
});
