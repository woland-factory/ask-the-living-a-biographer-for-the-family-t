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
 * every gap-map load.
 */
export async function seedBankQuestions(db: Queryable, spaceId: string): Promise<void> {
  for (const q of BANK) {
    await db.query(
      `INSERT INTO questions (space_id, origin, topic, text, bank_question_key, status)
       VALUES ($1, 'bank', $2, $3, $4, 'open')
       ON CONFLICT (space_id, bank_question_key) DO NOTHING`,
      [spaceId, q.topic, q.text, q.key]
    );
  }
}
