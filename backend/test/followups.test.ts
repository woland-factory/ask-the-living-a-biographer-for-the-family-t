import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFollowupPrompt,
  filterCandidates,
  generateFollowups,
  parseCandidates,
  passesRestraint,
} from "../src/lib/followups.js";
import { copyViolations } from "../src/lib/copy-rules.js";
import type { ChatFn, LlmAccess } from "../src/lib/llm.js";
import { makeTestApp, signIn, type TestContext } from "./helpers.js";

// The wounding questions a raw chatbot or fixed prompt list would blurt out.
// None may ever survive the guardrail.
const WOUNDING = [
  "How did it feel when he died?",
  "How are you coping without her?",
  "Did you get to say goodbye?",
  "Why do you think she did it?",
  "Were there any warning signs?",
  "Do you regret not reconciling with him?",
  "Whose fault was the estrangement?",
  "What were his last words?",
  "How did she pass away?",
];

// Gentle, grounded questions a kind biographer would ask.
const GENTLE = [
  "What did his coffee mornings look like?",
  "What did she like to grow in her garden?",
  "What kinds of radios did he like to fix?",
  "What was your favorite game to play with him?",
  "What is a story he liked to tell?",
];

// The four canned grief scenarios the differentiator names.
const SCENARIOS = [
  {
    name: "a fresh widow",
    subjectName: "Daniel",
    topicLabel: "Everyday life",
    transcript: "He always made the coffee before I woke up. The kitchen smelled of it.",
  },
  {
    name: "a child",
    subjectName: "Grandpa Joe",
    topicLabel: "Work and making",
    transcript: "Grandpa Joe fixed old radios in the garage and let me hold the tools.",
  },
  {
    name: "a recent suicide",
    subjectName: "Marcus",
    topicLabel: "Who they were",
    transcript: "Marcus loved telling long stories at dinner. Everyone went quiet to listen.",
  },
  {
    name: "an estranged parent",
    subjectName: "my father",
    topicLabel: "Family",
    transcript: "We did not speak for years. He grew tomatoes on the back step every summer.",
  },
];

describe("passesRestraint", () => {
  it("rejects every wounding fixture", () => {
    for (const q of WOUNDING) {
      expect(passesRestraint(q).ok, q).toBe(false);
    }
  });

  it("accepts every gentle fixture", () => {
    for (const q of GENTLE) {
      const result = passesRestraint(q);
      expect(result.ok, `${q} -> ${result.reasons.join(",")}`).toBe(true);
      expect(copyViolations(q)).toEqual([]);
    }
  });

  it("rejects a stacked double question", () => {
    expect(passesRestraint("What did he cook? Who was it for?").ok).toBe(false);
  });

  it("rejects a candidate that is not a question", () => {
    expect(passesRestraint("Tell me more about him.").ok).toBe(false);
  });

  it("rejects an over-long candidate", () => {
    const long = "What " + "very ".repeat(40) + "long question is this?";
    expect(passesRestraint(long).ok).toBe(false);
  });

  it("rejects a candidate that fails the copy sweep", () => {
    expect(passesRestraint("What did he unlock in you?").ok).toBe(false);
  });
});

describe("filterCandidates", () => {
  it("keeps only safe survivors and drops the wounding ones", () => {
    const mixed = [GENTLE[0], WOUNDING[0], WOUNDING[3]];
    expect(filterCandidates(mixed)).toEqual([GENTLE[0]]);
  });

  it("de-duplicates and caps at two", () => {
    const many = [GENTLE[0], GENTLE[0], GENTLE[1], GENTLE[2]];
    const out = filterCandidates(many);
    expect(out).toEqual([GENTLE[0], GENTLE[1]]);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe("parseCandidates", () => {
  it("treats NONE as no candidates", () => {
    expect(parseCandidates("NONE")).toEqual([]);
    expect(parseCandidates("")).toEqual([]);
  });

  it("strips list markers and quotes", () => {
    expect(parseCandidates('1. "What did he cook?"')).toEqual(["What did he cook?"]);
  });
});

describe("buildFollowupPrompt", () => {
  it("carries the restraint rules and the scenario transcript", () => {
    const ctx = SCENARIOS[0];
    const messages = buildFollowupPrompt(ctx);
    const system = messages.find((m) => m.role === "system")!.content;
    const user = messages.find((m) => m.role === "user")!.content;
    expect(system).toMatch(/one/i);
    expect(system).toMatch(/never mention or ask about the death/i);
    expect(system).toMatch(/NONE/);
    expect(user).toContain(ctx.transcript);
    expect(user).toContain(ctx.subjectName);
  });
});

const gatewayAccess: LlmAccess = {
  mode: "gateway",
  baseUrl: "https://gateway.example/v1",
  apiKey: "gw",
  model: "claude-haiku",
};

describe("generateFollowups", () => {
  it("returns [] when the mode is off, without calling the model", async () => {
    let called = false;
    const chat: ChatFn = async () => {
      called = true;
      return GENTLE[0];
    };
    const out = await generateFollowups({
      access: { mode: "off", baseUrl: "", apiKey: "", model: "" },
      chat,
      ctx: SCENARIOS[0],
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns [] when the model call throws", async () => {
    const chat: ChatFn = async () => {
      throw new Error("timeout");
    };
    const out = await generateFollowups({ access: gatewayAccess, chat, ctx: SCENARIOS[0] });
    expect(out).toEqual([]);
  });

  it("returns only safe survivors from a mixed model reply", async () => {
    const chat: ChatFn = async () => `${GENTLE[0]}\n${WOUNDING[0]}`;
    const out = await generateFollowups({ access: gatewayAccess, chat, ctx: SCENARIOS[0] });
    expect(out).toEqual([GENTLE[0]]);
  });
});

describe("POST /answers/:id/followups endpoint", () => {
  let ctx: TestContext;
  let reply: () => Promise<string>;
  const GRANTED = "fu-user@example.com";

  const chat: ChatFn = () => reply();

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

  // Sign in once per email; the per-email magic-link limiter caps at 5.
  const cookies = new Map<string, string>();
  async function cookieFor(email: string): Promise<string> {
    if (!cookies.has(email)) cookies.set(email, await signIn(ctx.app, email));
    return cookies.get(email)!;
  }

  async function setup(email: string, transcript: string | null) {
    const cookie = await cookieFor(email);
    const space = await ctx.app.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: "Daniel Okoro" },
    });
    const spaceId = space.json().id;
    const session = await ctx.app.inject({
      method: "POST",
      url: `/spaces/${spaceId}/sessions`,
      headers: { cookie },
    });
    const sessionId = session.json().id;
    const created = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answers`,
      headers: { cookie },
      payload: {
        bank_question_key: "everyday-ordinary-day",
        prompt_text: "What did an ordinary day look like for them?",
        topic: "everyday",
        duration_ms: 2000,
      },
    });
    const answerId = created.json().id;
    if (transcript !== null) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/answers/${answerId}`,
        headers: { cookie },
        payload: { transcript_status: "done", transcript },
      });
    }
    return { cookie, spaceId, sessionId, answerId };
  }

  it("stores a safe follow-up and surfaces it on the gap map", async () => {
    reply = async () => "What did his coffee mornings look like?";
    const { cookie, spaceId, answerId } = await setup(
      GRANTED,
      "He made the coffee every morning before anyone else woke."
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("gateway");
    expect(body.followups).toHaveLength(1);
    expect(body.followups[0].text).toBe("What did his coffee mornings look like?");

    const row = await ctx.db.query<{
      origin: string;
      parent_answer_id: string;
      membership_id: string;
    }>(
      "SELECT origin, parent_answer_id, membership_id FROM questions WHERE id = $1",
      [body.followups[0].id]
    );
    expect(row.rows[0].origin).toBe("followup");
    expect(row.rows[0].parent_answer_id).toBe(answerId);
    expect(row.rows[0].membership_id).not.toBeNull();

    const map = await ctx.app.inject({
      method: "GET",
      url: `/spaces/${spaceId}/questions`,
      headers: { cookie },
    });
    const texts = map.json().questions.map((q: { text: string }) => q.text);
    expect(texts).toContain("What did his coffee mornings look like?");
  });

  it("stores nothing when the model returns a wounding candidate", async () => {
    reply = async () => "How did he die?";
    const { cookie, answerId } = await setup(GRANTED, "He loved his garden.");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.json().followups).toEqual([]);
    const rows = await ctx.db.query(
      "SELECT 1 FROM questions WHERE parent_answer_id = $1",
      [answerId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("caps stored follow-ups at two per answer", async () => {
    reply = async () =>
      [
        "What did his coffee mornings look like?",
        "What did she like to grow in her garden?",
        "What kinds of radios did he like to fix?",
      ].join("\n");
    const { cookie, answerId } = await setup(GRANTED, "He fixed radios and grew tomatoes.");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.json().followups.length).toBeLessThanOrEqual(2);
    const rows = await ctx.db.query(
      "SELECT 1 FROM questions WHERE parent_answer_id = $1",
      [answerId]
    );
    expect(rows.rows.length).toBeLessThanOrEqual(2);
  });

  it("returns [] and mode off for a user with no key or grant, and the bank still continues", async () => {
    reply = async () => "What did his coffee mornings look like?";
    const { cookie, sessionId, answerId } = await setup(
      "fu-off@example.com",
      "He always sang in the kitchen."
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.json()).toEqual({ followups: [], mode: "off" });
    const rows = await ctx.db.query(
      "SELECT 1 FROM questions WHERE parent_answer_id = $1",
      [answerId]
    );
    expect(rows.rows).toHaveLength(0);

    // The interview still offers the next bank question via the session.
    const session = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(session.json().followups).toEqual([]);
  });

  it("writes no rows when the answer has no completed transcript", async () => {
    reply = async () => "What did his coffee mornings look like?";
    const { cookie, answerId } = await setup(GRANTED, null);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.json().followups).toEqual([]);
    const rows = await ctx.db.query(
      "SELECT 1 FROM questions WHERE parent_answer_id = $1",
      [answerId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("still returns 200 with [] when the model throws", async () => {
    reply = async () => {
      throw new Error("boom");
    };
    const { cookie, answerId } = await setup(GRANTED, "He told the best stories.");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().followups).toEqual([]);
  });

  it("enforces auth and membership", async () => {
    reply = async () => "What did his coffee mornings look like?";
    const { answerId } = await setup(GRANTED, "He loved the sea.");
    const anon = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
    });
    expect(anon.statusCode).toBe(401);

    const strangerCookie = await signIn(ctx.app, "fu-stranger@example.com");
    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `/answers/${answerId}/followups`,
      headers: { cookie: strangerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("grief-tone harness across the four scenarios", () => {
  for (const scenario of SCENARIOS) {
    it(`never lets a wounding follow-up survive for ${scenario.name}`, () => {
      // A model that returns every wounding question mixed with one gentle one.
      const modelReply = [...WOUNDING, GENTLE[0]].join("\n");
      const survivors = filterCandidates(parseCandidates(modelReply));
      for (const s of survivors) {
        expect(passesRestraint(s).ok, s).toBe(true);
        expect(copyViolations(s)).toEqual([]);
      }
      // No wounding question is ever among the survivors.
      for (const w of WOUNDING) {
        expect(survivors).not.toContain(w);
      }
    });
  }
});
