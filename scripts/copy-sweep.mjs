#!/usr/bin/env node
// Mechanical copy sweep (QUALITY BAR §8). Scans user-visible strings for
// em/en dashes, banned LLM vocabulary, and negative empty-state phrasing.
// Exits non-zero on any hit so it can gate CI.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGET_DIRS = [path.join(root, "frontend", "src")];
const TARGET_FILES = [
  path.join(root, "frontend", "index.html"),
  path.join(root, "backend", "src", "lib", "copy.ts"),
  path.join(root, "backend", "src", "lib", "export.ts"),
  path.join(root, "backend", "src", "lib", "mailer.ts"),
  path.join(root, "backend", "src", "seed.ts"),
  path.join(root, "shared", "bank.json"),
  path.join(root, "README.md"),
];
const EXTS = new Set([".ts", ".tsx", ".css", ".html"]);

const CHECKS = [
  { name: "em-dash", re: /—/ },
  { name: "en-dash", re: /–/ },
  { name: "banned vocabulary", re: /\b(seamlessly|effortlessly|unlock|elevate|empower|leverage|robust|dive in|we've got you covered)\b/i },
  { name: "banned phrase", re: /in today's fast-paced world/i },
  { name: "negative phrasing (you don't have)", re: /\byou don't have\b/i },
  { name: "negative phrasing (no ... yet)", re: /\bno\s+\w+\s+yet\b/i },
  { name: "negative phrasing (nothing here)", re: /\bnothing\s+\w*\s*here\b/i },
  { name: "negative phrasing (unable to)", re: /\bunable to\b/i },
  { name: "negative phrasing (something went wrong)", re: /something went wrong/i },
];

function collect(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...collect(full));
    else if (EXTS.has(path.extname(full))) out.push(full);
  }
  return out;
}

const files = [
  ...TARGET_DIRS.flatMap(collect),
  ...TARGET_FILES.filter(existsSync),
];

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const check of CHECKS) {
      if (check.re.test(line)) {
        violations.push(`${path.relative(root, file)}:${i + 1}  [${check.name}]  ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Copy sweep found problems:");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`Copy sweep passed (${files.length} files scanned).`);
