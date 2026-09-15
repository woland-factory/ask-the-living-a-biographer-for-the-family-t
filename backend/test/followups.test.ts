import { describe, expect, it } from "vitest";
import {
  buildFollowupPrompt,
  filterCandidates,
  generateFollowups,
  parseCandidates,
  passesRestraint,
} from "../src/lib/followups.js";
import { copyViolations } from "../src/lib/copy-rules.js";
import type { ChatFn, LlmAccess } from "../src/lib/llm.js";

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
