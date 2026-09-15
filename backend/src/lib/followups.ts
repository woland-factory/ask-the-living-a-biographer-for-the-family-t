import { copyViolations } from "./copy-rules.js";
import type { ChatFn, LlmAccess } from "./llm.js";

// The restraint engine. A model may draft a gentle follow-up, but nothing it
// writes reaches a grieving person until it clears the deterministic guardrail
// below. When in doubt the guardrail rejects; a dropped candidate simply means
// no follow-up, and silence is always safe.

export interface FollowupContext {
  subjectName: string;
  topicLabel: string;
  transcript: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const CALL_TIMEOUT_MS = 20_000;
const MAX_LEN = 140;
const MAX_FOLLOWUPS = 2;

// Rule 2: the death/harm lexicon. The app never introduces the death, its
// cause, or its manner. Word-boundary, case-insensitive.
const DEATH_LEXICON =
  /\b(die|died|death|dying|dead|pass(ed)?\s+away|funeral|burial|grave|cause of death|suicide|kill|overdose|illness|cancer|accident|hospice)\b/i;

// Rule 3: prying at feelings.
const FEELINGS_PATTERNS: RegExp[] = [
  /how\s+(did|does|do)\b.*\bfeel/i,
  /how\s+are\s+you\s+(doing|coping|holding up)/i,
  /\bcoping\b/i,
  /\bclosure\b/i,
  /\bmove on\b/i,
  /\bget over\b/i,
];

// Rule 4: pressure or blame.
const BLAME_PATTERNS: RegExp[] = [
  /\bregret\b/i,
  /\bguilt\b/i,
  /\bblame\b/i,
  /\bfault\b/i,
  /\bshould have\b/i,
  /\bwhose fault\b/i,
  /\bwhy\s+(did|do)\s+(you|they)\b/i,
  /\bworst\b/i,
  /\bsuffer(ing)?\b/i,
  /\bpain\b/i,
  /\blast words\b/i,
  /\bsay goodbye\b/i,
  /\bwarning signs\b/i,
];

/**
 * The deterministic restraint guardrail. A candidate passes only if every rule
 * holds. Returns the failing rule names so tests and logs can see why.
 */
export function passesRestraint(text: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const trimmed = text.trim();

  // Rule 1: exactly one question, one sentence.
  if (!trimmed.endsWith("?")) {
    reasons.push("not-a-single-question");
  } else {
    const body = trimmed.slice(0, -1);
    // A second terminal mark hides a second ask or a second sentence.
    if (/[?.!]/.test(body)) reasons.push("more-than-one-sentence");
  }

  // Rule 2: never the death, its cause, or its manner.
  if (DEATH_LEXICON.test(trimmed)) reasons.push("death-or-harm");

  // Rule 3: no prying at feelings.
  if (FEELINGS_PATTERNS.some((re) => re.test(trimmed))) reasons.push("pries-at-feelings");

  // Rule 4: no pressure or blame.
  if (BLAME_PATTERNS.some((re) => re.test(trimmed))) reasons.push("pressure-or-blame");

  // Rule 5: short.
  if (trimmed.length > MAX_LEN) reasons.push("too-long");

  // Rule 6: passes the copy sweep.
  if (copyViolations(trimmed).length > 0) reasons.push("copy-sweep");

  return { ok: reasons.length === 0, reasons };
}

/**
 * Split raw model text into candidate questions. The model is asked for at
 * most one question or the literal token NONE; be liberal about list markers
 * and extra lines. NONE or empty yields no candidates.
 */
export function parseCandidates(modelText: string): string[] {
  if (!modelText) return [];
  return modelText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\d.)]+\s*)?/, "").trim())
    .map((line) => line.replace(/^["'“”]+|["'“”]+$/g, "").trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE");
}

/** Keep only restrained survivors, de-duplicate, and cap the count. */
export function filterCandidates(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!passesRestraint(c).ok) continue;
    const key = c.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.trim());
    if (out.length >= MAX_FOLLOWUPS) break;
  }
  return out;
}

/**
 * Build the prompt. The system message carries the restraint rules in the
 * product's own gentle voice and asks for one short question grounded in what
 * the teller actually said, or the literal token NONE when nothing gentle fits.
 */
export function buildFollowupPrompt(ctx: FollowupContext): ChatMessage[] {
  const system = [
    "You are a kind, unhurried biographer helping a grieving family remember someone they lost.",
    `The person being remembered is ${ctx.subjectName}. The current topic is: ${ctx.topicLabel}.`,
    "Read what the family member just said and offer at most ONE short follow-up question that a gentle listener would ask next.",
    "Ground the question in something concrete they actually mentioned. Keep it warm, plain, and specific.",
    "Hard rules you must never break:",
    "1. Ask exactly one short question, one sentence, ending with a question mark.",
    "2. Never mention or ask about the death, its cause, or how the person died.",
    "3. Never ask how they feel, how they are coping, or about closure or moving on.",
    "4. Never imply blame, guilt, regret, fault, suffering, last words, or goodbyes.",
    "5. Keep it under 140 characters.",
    "If no gentle, grounded question fits, reply with the single word NONE.",
    "Reply with only the question, or NONE. No preamble.",
  ].join("\n");

  const user = `Here is what they said about ${ctx.subjectName}:\n\n${ctx.transcript}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Orchestrate one round of follow-up generation. Off means no call at all.
 * Any failure resolves to an empty list. It never throws and never blocks.
 */
export async function generateFollowups(args: {
  access: LlmAccess;
  chat: ChatFn;
  ctx: FollowupContext;
}): Promise<string[]> {
  const { access, chat, ctx } = args;
  if (access.mode === "off") return [];
  try {
    const text = await chat({
      baseUrl: access.baseUrl,
      apiKey: access.apiKey,
      model: access.model,
      messages: buildFollowupPrompt(ctx),
      timeoutMs: CALL_TIMEOUT_MS,
    });
    return filterCandidates(parseCandidates(text));
  } catch {
    return [];
  }
}
