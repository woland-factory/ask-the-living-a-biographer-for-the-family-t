// The biographer's question bank. A curated, ordered, in-code list. Order is
// the interview order. The client walks it, skipping answered keys and
// deferred topics. Every string here is copy-swept: plain, gentle, concrete,
// and it never pries about feelings or assumes how the person died.

export interface BankQuestion {
  key: string;
  topic: string;
  text: string;
}

export const BANK: BankQuestion[] = [
  { key: "beginnings-hometown", topic: "beginnings", text: "Where did they grow up, and what was the house like?" },
  { key: "beginnings-childhood-story", topic: "beginnings", text: "What is a story they told about their own childhood?" },
  { key: "family-how-they-met", topic: "family", text: "How did they meet the people they built a family with?" },
  { key: "family-who-they-leaned-on", topic: "family", text: "Who did they turn to when things got hard?" },
  { key: "everyday-ordinary-day", topic: "everyday", text: "What did an ordinary day look like for them?" },
  { key: "everyday-cooking", topic: "everyday", text: "What did they cook, and who did they cook it for?" },
  { key: "character-laughter", topic: "character", text: "What could always make them laugh?" },
  { key: "character-what-they-defended", topic: "character", text: "What did they care about enough to argue over?" },
  { key: "together-a-day-you-keep", topic: "together", text: "Tell me about a day with them you still think about." },
  { key: "together-what-they-taught", topic: "together", text: "What is something they taught you without meaning to?" },
  { key: "work-their-days", topic: "work", text: "What work filled their days, and were they proud of it?" },
  { key: "work-with-their-hands", topic: "work", text: "What could they fix, make, or do with their hands?" },
  { key: "later-comfort", topic: "later", text: "What brought them comfort in their later years?" },
  { key: "later-looking-forward", topic: "later", text: "What were they still looking forward to?" },
  { key: "keeping-never-forget", topic: "keeping", text: "What do you never want the family to forget about them?" },
  { key: "keeping-thank-you", topic: "keeping", text: "What would you thank them for, if they were here?" },
];

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
