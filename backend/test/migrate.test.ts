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
    expect(first).toContain("0003_followups.sql");
    expect(first).toContain("0004_invites.sql");
    expect(first).toContain("0005_tellings.sql");

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
      "llm_credentials",
      "questions",
      "invites",
      "stories",
    ]) {
      expect(names).toContain(t);
    }

    // The origin CHECK now admits the cross-telling question.
    await db.query(
      "INSERT INTO users (email, display_name) VALUES ('m-origin@example.com', 'M')"
    );
    const owner = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'm-origin@example.com'"
    );
    const space = await db.query<{ id: string }>(
      `INSERT INTO spaces (subject_name, created_by) VALUES ('Rosa', $1) RETURNING id`,
      [owner.rows[0].id]
    );
    const membership = await db.query<{ id: string }>(
      `INSERT INTO memberships (space_id, user_id, role)
       VALUES ($1, $2, 'organizer') RETURNING id`,
      [space.rows[0].id, owner.rows[0].id]
    );
    const story = await db.query<{ id: string }>(
      `INSERT INTO stories (space_id, label) VALUES ($1, 'A story') RETURNING id`,
      [space.rows[0].id]
    );
    await db.query(
      `INSERT INTO questions (space_id, membership_id, origin, topic, text, story_id, status)
       VALUES ($1, $2, 'crosstelling', 'everyday', 'A gentle question?', $3, 'open')`,
      [space.rows[0].id, membership.rows[0].id, story.rows[0].id]
    );
    // The partial unique index allows only one OPEN crosstelling per teller.
    await expect(
      db.query(
        `INSERT INTO questions (space_id, membership_id, origin, topic, text, story_id, status)
         VALUES ($1, $2, 'crosstelling', 'everyday', 'Another one?', $3, 'open')`,
        [space.rows[0].id, membership.rows[0].id, story.rows[0].id]
      )
    ).rejects.toThrow();

    // Re-running applies nothing new.
    const second = await runMigrations(db);
    expect(second).toEqual([]);
  });

  it("makes email nullable so guests coexist and magic-link sign-in still works", async () => {
    db = await createPgliteDb();
    await runMigrations(db);

    // Two guest rows with NULL email prove UNIQUE(email) tolerates guests.
    await db.query("INSERT INTO users (email, display_name) VALUES (NULL, 'Carol')");
    await db.query("INSERT INTO users (email, display_name) VALUES (NULL, 'Sam')");
    const guests = await db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM users WHERE email IS NULL"
    );
    expect(Number(guests.rows[0].n)).toBe(2);

    // A real email still inserts and stays unique.
    await db.query("INSERT INTO users (email) VALUES ('someone@example.com')");
    await expect(
      db.query("INSERT INTO users (email) VALUES ('someone@example.com')")
    ).rejects.toThrow();
  });
});
