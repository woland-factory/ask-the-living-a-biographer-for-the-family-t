import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { runMigrations } from "../src/db/migrate.js";
import { signIn } from "./helpers.js";

describe("persistence across a fresh connection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atl-persist-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a created space after reconnecting to the same database", async () => {
    // First connection: create a space.
    const db1 = await createPgliteDb(dir);
    await runMigrations(db1);
    const app1 = await buildApp({
      db: db1,
      config: {
        isE2E: true,
        isProduction: false,
        sessionSecret: "persist-secret-value-for-signing-cookies-123456",
        publicBaseUrl: "http://127.0.0.1",
      },
    });
    await app1.ready();
    const cookie = await signIn(app1, "keeper@example.com");
    const create = await app1.inject({
      method: "POST",
      url: "/spaces",
      headers: { cookie },
      payload: { subject_name: "Durable Subject" },
    });
    const spaceId = create.json().id;
    expect(create.statusCode).toBe(201);
    await app1.close();
    await db1.close();

    // Second connection: fresh pool over the same on-disk database.
    const db2 = await createPgliteDb(dir);
    await runMigrations(db2); // idempotent; applies nothing
    const { rows } = await db2.query<{ subject_name: string }>(
      "SELECT subject_name FROM spaces WHERE id = $1",
      [spaceId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_name).toBe("Durable Subject");
    await db2.close();
  });
});
