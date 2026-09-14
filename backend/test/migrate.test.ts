import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

describe("migration runner", () => {
  let db: Db;
  afterEach(async () => {
    if (db) await db.close();
  });

  it("creates every table on an empty DB and is idempotent", async () => {
    db = await createPgliteDb();
    const first = await runMigrations(db);
    expect(first).toContain("0001_init.sql");
    expect(first).toContain("0002_interview.sql");

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of [
      "users",
      "magic_link_tokens",
      "auth_sessions",
      "spaces",
      "memberships",
      "interview_sessions",
      "answers",
      "answer_audio",
      "topic_deferrals",
    ]) {
      expect(names).toContain(t);
    }

    // Re-running applies nothing new.
    const second = await runMigrations(db);
    expect(second).toEqual([]);
  });
});
