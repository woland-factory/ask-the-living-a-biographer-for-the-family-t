import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Queryable } from "../db/index.js";

// The question bank is one file, shared/bank.json at the repo root. The
// frontend imports it directly; the backend reads it here so the gap map can
// show unanswered bank questions as open gaps without a duplicate copy. The
// path resolves the same from src (dev/tests) and dist (prod): up three levels
// to the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));

export interface BankQuestion {
  key: string;
  topic: string;
  text: string;
}

function sharedBankPath(): string {
  return process.env.SHARED_BANK_PATH ?? path.resolve(here, "../../../shared/bank.json");
}

export const BANK: BankQuestion[] = JSON.parse(
  readFileSync(sharedBankPath(), "utf8")
) as BankQuestion[];

/**
 * Seed one open bank question per (space, bank key). Idempotent: the unique
 * index on (space_id, bank_question_key) makes ON CONFLICT DO NOTHING skip
 * rows already present, so this is safe to run on every interview start and on
 * every gap-map load. One multi-row insert, one round-trip: the gap-map read
 * does not pay a write per bank question to render.
 */
export async function seedBankQuestions(db: Queryable, spaceId: string): Promise<void> {
  if (BANK.length === 0) return;
  // $1 is the space id, reused by every row. Each question adds three params.
  const params: unknown[] = [spaceId];
  const tuples = BANK.map((q, i) => {
    const base = i * 3 + 2;
    params.push(q.topic, q.text, q.key);
    return `($1, 'bank', $${base}, $${base + 1}, $${base + 2}, 'open')`;
  });
  await db.query(
    `INSERT INTO questions (space_id, origin, topic, text, bank_question_key, status)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (space_id, bank_question_key) DO NOTHING`,
    params
  );
}
