import pg from "pg";
import type { Db, Queryable, QueryResult } from "./index.js";

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });

  const toResult = <T>(r: pg.QueryResult): QueryResult<T> => ({
    rows: r.rows as T[],
    rowCount: r.rowCount ?? r.rows.length,
  });

  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await pool.query(text, params as unknown[]);
      return toResult<T>(r);
    },
    async exec(sql: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = {
          async query<R>(text: string, params?: unknown[]) {
            const r = await client.query(text, params as unknown[]);
            return toResult<R>(r);
          },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
