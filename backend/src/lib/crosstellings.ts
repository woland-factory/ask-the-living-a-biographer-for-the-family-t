import {
  filterCandidates,
  parseCandidates,
  type ChatMessage,
} from "./followups.js";
import type { ChatFn, LlmAccess } from "./llm.js";

// The signature moment. Two grieving people tell the same memory, and the app
// asks each the single gentle question the other's telling left open. This is
// the most delicate place a model speaks in the whole product, so its safety is
// exactly EPIC 3's safety, turned across people: the same restraint guardrail
// (parseCandidates + filterCandidates, which runs passesRestraint and the copy
// sweep) gates every word. When nothing gentle fits, the answer is silence.

export interface CrossTellingContext {
  subjectName: string;
  storyLabel: string;
  // The teller the question is posed TO.
  mine: string; // this teller's telling transcript(s), joined
  // The other teller(s) whose telling raises the question.
  theirs: string; // the other telling transcript(s), joined
  topic: string; // topic label carried onto the question row
}

const CALL_TIMEOUT_MS = 20_000;

/**
 * Build the prompt. The system message is in the product's own gentle voice and
 * forbids, in words, the same wounding moves the restraint rules encode. The
 * user message labels both transcripts clearly so the model grounds its one
 * question in what the OTHER person actually said.
 */
export function buildCrossTellingPrompt(ctx: CrossTellingContext): ChatMessage[] {
  const system = [
    "You are a kind, unhurried biographer helping a grieving family remember someone they lost.",
    `The person being remembered is ${ctx.subjectName}. You are comparing two people's tellings of the same memory: ${ctx.storyLabel}.`,
    "Return at most ONE short, gentle question that the OTHER person's telling raises and that THIS person's telling left open.",
    "Ground it in something the other person actually said, and make it answerable by this person.",
    "Hard rules you must never break:",
    "1. Ask exactly one short question, one sentence, ending with a question mark.",
    "2. Never mention or ask about the death, its cause, or how the person died.",
    "3. Never ask how they feel, how they are coping, or about closure or moving on.",
    "4. Never imply blame, guilt, regret, fault, suffering, last words, or goodbyes.",
    "5. Keep it under 140 characters.",
    "If no gentle, grounded question fits, reply with the single word NONE.",
    "Reply with only the question, or NONE. No preamble.",
  ].join("\n");

  const user = [
    `This is about ${ctx.subjectName}, remembering: ${ctx.storyLabel}.`,
    "",
    "This person said:",
    ctx.mine,
    "",
    "The other person said:",
    ctx.theirs,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Generate the one gentle cross-question, or null. Off means no call at all.
 * filterCandidates runs on every path, so nothing wounding and nothing that
 * fails the copy sweep can ever be returned. Any thrown error resolves to null.
 * It never throws and never blocks. A null is the safe, expected outcome.
 */
export async function generateCrossQuestion(args: {
  access: LlmAccess;
  chat: ChatFn;
  ctx: CrossTellingContext;
}): Promise<string | null> {
  const { access, chat, ctx } = args;
  if (access.mode === "off") return null;
  try {
    const text = await chat({
      baseUrl: access.baseUrl,
      apiKey: access.apiKey,
      model: access.model,
      messages: buildCrossTellingPrompt(ctx),
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const survivors = filterCandidates(parseCandidates(text));
    return survivors[0] ?? null;
  } catch {
    return null;
  }
}
