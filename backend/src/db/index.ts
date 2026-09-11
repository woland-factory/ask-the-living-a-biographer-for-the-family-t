export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run a multi-statement SQL string atomically (used by the migration runner). */
  exec(sql: string): Promise<void>;
  /** Run a set of queries in a single transaction. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbKind = "pg" | "pglite";

/**
 * Build the database for the current runtime.
 * PGlite (an in-process Postgres) backs tests and the e2e build so the suite
 * needs no external database. Real Postgres backs dev and production.
 */
export async function createDb(): Promise<Db> {
  if (process.env.E2E === "1" || process.env.USE_PGLITE === "1") {
    const { createPgliteDb } = await import("./pglite.js");
    return createPgliteDb(process.env.PGLITE_DIR || undefined);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to start the server");
  }
  const { createPgDb } = await import("./pg.js");
  return createPgDb(url);
}
