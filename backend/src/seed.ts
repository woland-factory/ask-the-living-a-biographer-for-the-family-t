import type { Db } from "./db/index.js";

export interface SeedLogger {
  info: (msg: string) => void;
}

/**
 * Idempotent demo-seed entry point, run on startup when SEED_DEMO=1.
 * This EPIC seeds no content; it is the extension point later work fills.
 * Safe to run repeatedly.
 */
export async function seedDemo(_db: Db, log: SeedLogger): Promise<void> {
  log.info("SEED_DEMO is on: demo seed ran (no sample content in this version)");
}
