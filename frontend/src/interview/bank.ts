// The biographer's question bank. A curated, ordered list. Order is the
// interview order. The client walks it, skipping answered keys and deferred
// topics. The data lives once in shared/bank.json (imported here and read by
// the backend for the gap map), so the two never drift. Every string there is
// copy-swept: plain, gentle, concrete, and it never pries about feelings or
// assumes how the person died.
import bankData from "../../../shared/bank.json";

export interface BankQuestion {
  key: string;
  topic: string;
  text: string;
}

export const BANK: BankQuestion[] = bankData as BankQuestion[];

export const TOPIC_LABELS: Record<string, string> = {
  beginnings: "Their early life",
  family: "Family",
  everyday: "Everyday life",
  character: "Who they were",
  together: "You and them",
  work: "Work and making",
  later: "Later years",
  keeping: "What to keep",
};

export function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? "";
}

/**
 * The next question to ask: the first bank entry whose key has not been
 * answered and whose topic has not been deferred. Returns null when the bank
 * is complete, which the UI treats as a finished sitting, never an error.
 */
export function nextQuestion(
  answeredKeys: readonly string[],
  deferredTopics: readonly string[]
): BankQuestion | null {
  const answered = new Set(answeredKeys);
  const deferred = new Set(deferredTopics);
  for (const q of BANK) {
    if (answered.has(q.key)) continue;
    if (deferred.has(q.topic)) continue;
    return q;
  }
  return null;
}
