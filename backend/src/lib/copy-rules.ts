// Shared copy rules (QUALITY BAR §8). The static sweep (scripts/copy-sweep.mjs)
// and the runtime restraint guardrail both need the same checks, so they live
// here once. scripts/copy-sweep.mjs keeps its own literal list for zero-build
// scanning; the anti-drift test (copy-rules.test.ts) proves this runtime list
// covers every pattern the static script lists, so the two never diverge.

export interface CopyCheck {
  name: string;
  re: RegExp;
}

export const COPY_CHECKS: CopyCheck[] = [
  { name: "em-dash", re: /—/ },
  { name: "en-dash", re: /–/ },
  {
    name: "banned vocabulary",
    re: /\b(seamlessly|effortlessly|unlock|elevate|empower|leverage|robust|dive in|we've got you covered)\b/i,
  },
  { name: "banned phrase", re: /in today's fast-paced world/i },
  { name: "negative phrasing (you don't have)", re: /\byou don't have\b/i },
  { name: "negative phrasing (no ... yet)", re: /\bno\s+\w+\s+yet\b/i },
  { name: "negative phrasing (nothing here)", re: /\bnothing\s+\w*\s*here\b/i },
  { name: "negative phrasing (unable to)", re: /\bunable to\b/i },
  { name: "negative phrasing (something went wrong)", re: /something went wrong/i },
];

/** Every copy-rule the text violates, by name. Empty means the text is clean. */
export function copyViolations(text: string): string[] {
  const hits: string[] = [];
  for (const check of COPY_CHECKS) {
    if (check.re.test(text)) hits.push(check.name);
  }
  return hits;
}
