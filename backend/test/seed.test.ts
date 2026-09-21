import { describe, expect, it } from "vitest";
import { createPgliteDb } from "../src/db/pglite.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDemo, DEMO } from "../src/seed.js";
import { passesRestraint } from "../src/lib/followups.js";
import { copyViolations } from "../src/lib/copy-rules.js";

const silent = { info: () => undefined };

describe("seedDemo", () => {
  it("seeds one family, one story, two tellings, two open cross-questions", async () => {
    const db = await createPgliteDb();
    await runMigrations(db);
    await seedDemo(db, silent);

    const spaces = await db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM spaces WHERE subject_name = $1",
      [DEMO.subjectName]
    );
    expect(Number(spaces.rows[0].n)).toBe(1);

    // Two contributor memberships, both guest users (email IS NULL).
    const contributors = await db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.role = 'contributor' AND u.email IS NULL`
    );
    expect(Number(contributors.rows[0].n)).toBe(2);

    const stories = await db.query<{ id: string; n: string }>(
      "SELECT id, COUNT(*) OVER()::int AS n FROM stories WHERE label = $1",
      [DEMO.storyLabel]
    );
    expect(stories.rows).toHaveLength(1);
    const storyId = stories.rows[0].id;

    const answers = await db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM answers WHERE story_id = $1 AND transcript_status = 'done'",
      [storyId]
    );
    expect(Number(answers.rows[0].n)).toBe(2);

    const cross = await db.query<{ text: string; membership_id: string }>(
      "SELECT text, membership_id FROM questions WHERE story_id = $1 AND origin = 'crosstelling' AND status = 'open'",
      [storyId]
    );
    expect(cross.rows).toHaveLength(2);
    // One question per distinct teller.
    expect(new Set(cross.rows.map((r) => r.membership_id)).size).toBe(2);

    await db.close();
  });

  it("is idempotent across restarts", async () => {
    const db = await createPgliteDb();
    await runMigrations(db);
    await seedDemo(db, silent);
    await seedDemo(db, silent);

    const spaces = await db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM spaces WHERE subject_name = $1",
      [DEMO.subjectName]
    );
    expect(Number(spaces.rows[0].n)).toBe(1);
    const cross = await db.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM questions WHERE origin = 'crosstelling'"
    );
    expect(Number(cross.rows[0].n)).toBe(2);

    await db.close();
  });

  it("seeds only gentle, copy-clean cross-questions", () => {
    for (const q of DEMO.questions) {
      expect(passesRestraint(q).ok, q).toBe(true);
      expect(copyViolations(q)).toEqual([]);
    }
  });
});
