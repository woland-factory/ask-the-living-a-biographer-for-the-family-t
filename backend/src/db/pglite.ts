import type { Db, Queryable, QueryResult } from "./index.js";

interface PgliteResult {
  rows: unknown[];
  affectedRows?: number;
}

/**
 * In-process Postgres used by tests and the e2e build.
 * Pass a directory to persist, or leave undefined for a fresh in-memory db.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(dataDir);
  await client.waitReady;

  const toResult = <T>(r: PgliteResult): QueryResult<T> => ({
    rows: r.rows as T[],
    rowCount: r.rows.length > 0 ? r.rows.length : r.affectedRows ?? 0,
  });

  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = (await client.query(text, params as unknown[])) as PgliteResult;
      return toResult<T>(r);
    },
    async exec(sql: string) {
      // PGlite wraps a multi-statement exec in an implicit transaction and
      // rolls back on error.
      await client.exec(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return client.transaction(async (tx) => {
        const wrapped = {
          async query<R>(text: string, params?: unknown[]) {
            const r = (await tx.query(text, params as unknown[])) as PgliteResult;
            return toResult<R>(r);
          },
        };
        return fn(wrapped);
      }) as Promise<T>;
    },
    async close() {
      await client.close();
    },
  };
}
