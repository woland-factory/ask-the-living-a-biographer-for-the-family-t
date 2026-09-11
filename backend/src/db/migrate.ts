import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Default location of the .sql files, resolved relative to the compiled db module. */
export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../migrations");
}

export interface MigrationLogger {
  info: (msg: string) => void;
}

/**
 * Apply every not-yet-applied migration file in order, recording each in
 * schema_migrations. Idempotent: safe to run on every boot.
 */
export async function runMigrations(
  db: Db,
  dir: string = defaultMigrationsDir(),
  log: MigrationLogger = { info: () => undefined }
): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const filename of files) {
    const { rows } = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename]
    );
    if (rows.length > 0) continue;

    const sql = readFileSync(path.join(dir, filename), "utf8");
    const escaped = filename.replace(/'/g, "''");
    // Record the migration inside the same atomic exec so a crash never
    // leaves a half-applied file marked as done.
    const withRecord = `${sql}\nINSERT INTO schema_migrations (filename) VALUES ('${escaped}');`;
    await db.exec(withRecord);
    applied.push(filename);
    log.info(`migration applied: ${filename}`);
  }
  return applied;
}
