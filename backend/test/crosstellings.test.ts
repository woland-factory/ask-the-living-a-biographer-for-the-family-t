import { describe, expect, it } from "vitest";
import {
  buildCrossTellingPrompt,
  generateCrossQuestion,
  type CrossTellingContext,
} from "../src/lib/crosstellings.js";
import { passesRestraint } from "../src/lib/followups.js";
import { copyViolations } from "../src/lib/copy-rules.js";
import { DEMO } from "../src/seed.js";
import type { ChatFn, LlmAccess } from "../src/lib/llm.js";

const gatewayAccess: LlmAccess = {
  mode: "gateway",
  baseUrl: "https://gateway.example/v1",
  apiKey: "gw",
  model: "claude-haiku",
};

const offAccess: LlmAccess = { mode: "off", baseUrl: "", apiKey: "", model: "" };

// A grief scenario as a cross-telling: two people, two accounts of one memory,
// and the wounding questions a raw chatbot might blurt when told to "compare".
const SCENARIOS = [
  {
    name: "a fresh widow beside a child",
    ctx: {
      subjectName: "Daniel",
      storyLabel: "Mornings at home",
      mine: "He always made the coffee before I woke. The kitchen smelled of it.",
      theirs: "Grandpa let me grind the beans and set out two cups.",
      topic: "everyday",
    },
  },
  {
    name: "a recent suicide told by two siblings",
    ctx: {
      subjectName: "Marcus",
      storyLabel: "Dinners together",
      mine: "Marcus told long stories at dinner and everyone went quiet.",
      theirs: "He always saved the head of the table for our mother.",
      topic: "character",
    },
  },
  {
    name: "an estranged parent told by two children",
    ctx: {
      subjectName: "our father",
      storyLabel: "The back step garden",
      mine: "We did not speak for years. He grew tomatoes every summer.",
      theirs: "He kept a second row of beans just for the neighbors.",
      topic: "family",
    },
  },
  {
    name: "a grandmother told by daughter and sister",
    ctx: {
      subjectName: "Rosa",
      storyLabel: "The bakery on Sunday mornings",
      mine: "She sang in the kitchen while the bread baked.",
      theirs: "She opened before dawn and saved the first loaf for a neighbor.",
      topic: "everyday",
    },
  },
] satisfies { name: string; ctx: CrossTellingContext }[];

// Wounding replies a model must never get past the guardrail, even when the
// prompt is a comparison of two grieving accounts.
const WOUNDING = [
  "How did it feel when he died?",
  "How are you coping without her?",
  "Did you get to say goodbye?",
  "Why do you think she did it?",
  "Were there any warning signs?",
  "Do you regret not reconciling with him?",
  "What were his last words?",
];

describe("buildCrossTellingPrompt", () => {
  it("carries both labelled transcripts and the restraint instructions", () => {
    const ctx = SCENARIOS[0].ctx;
    const messages = buildCrossTellingPrompt(ctx);
    const system = messages.find((m) => m.role === "system")!.content;
    const user = messages.find((m) => m.role === "user")!.content;

    expect(system).toMatch(/one/i);
    expect(system).toMatch(/never mention or ask about the death/i);
    expect(system).toMatch(/NONE/);
    expect(system).toMatch(/comparing two people/i);

    expect(user).toContain("This person said:");
    expect(user).toContain("The other person said:");
    expect(user).toContain(ctx.mine);
    expect(user).toContain(ctx.theirs);
    expect(user).toContain(ctx.subjectName);
    expect(user).toContain(ctx.storyLabel);
  });
});

describe("generateCrossQuestion", () => {
  it("returns null when the mode is off, without calling the model", async () => {
    let called = false;
    const chat: ChatFn = async () => {
      called = true;
      return "What songs did she sing while the bread baked?";
    };
    const out = await generateCrossQuestion({
      access: offAccess,
      chat,
      ctx: SCENARIOS[3].ctx,
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the model call throws", async () => {
    const chat: ChatFn = async () => {
      throw new Error("timeout");
    };
    const out = await generateCrossQuestion({
      access: gatewayAccess,
      chat,
      ctx: SCENARIOS[0].ctx,
    });
    expect(out).toBeNull();
  });

  it("returns a survivor for a safe, grounded model reply", async () => {
    const chat: ChatFn = async () => "What songs did she sing while the bread baked?";
    const out = await generateCrossQuestion({
      access: gatewayAccess,
      chat,
      ctx: SCENARIOS[3].ctx,
    });
    expect(out).toBe("What songs did she sing while the bread baked?");
  });

  it("returns null for a wounding model reply", async () => {
    const chat: ChatFn = async () => "How did he die?";
    const out = await generateCrossQuestion({
      access: gatewayAccess,
      chat,
      ctx: SCENARIOS[0].ctx,
    });
    expect(out).toBeNull();
  });

  it("keeps only the gentle survivor from a mixed reply", async () => {
    const gentle = "What did the neighbor say about the first loaf?";
    const chat: ChatFn = async () => [WOUNDING[0], gentle, WOUNDING[3]].join("\n");
    const out = await generateCrossQuestion({
      access: gatewayAccess,
      chat,
      ctx: SCENARIOS[3].ctx,
    });
    expect(out).toBe(gentle);
  });
});

describe("grief-tone cross-telling harness", () => {
  for (const scenario of SCENARIOS) {
    it(`never lets a wounding cross-question survive for ${scenario.name}`, async () => {
      const gentle = "What did that morning smell like?";
      const chat: ChatFn = async () => [...WOUNDING, gentle].join("\n");
      const out = await generateCrossQuestion({
        access: gatewayAccess,
        chat,
        ctx: scenario.ctx,
      });
      // Only a gentle survivor, or silence, ever comes back.
      if (out !== null) {
        expect(passesRestraint(out).ok, out).toBe(true);
        expect(copyViolations(out)).toEqual([]);
        expect(WOUNDING).not.toContain(out);
      }
    });
  }
});

describe("seeded demo cross-questions", () => {
  it("both hand-authored demo questions pass the guardrail and the copy sweep", () => {
    for (const q of DEMO.questions) {
      const result = passesRestraint(q);
      expect(result.ok, `${q} -> ${result.reasons.join(",")}`).toBe(true);
      expect(copyViolations(q)).toEqual([]);
    }
    expect(DEMO.questions).toHaveLength(2);
  });
});
