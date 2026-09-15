import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { normalizeEmail } from "../src/lib/crypto.js";
import type { ChatFn } from "../src/lib/llm.js";

export interface TestContext {
  app: FastifyInstance;
  db: Db;
}

export async function makeTestApp(
  configOverride: Record<string, unknown> = {},
  opts: { llm?: { chat?: ChatFn } } = {}
): Promise<TestContext> {
  const db = await createPgliteDb();
  await runMigrations(db);
  const app = await buildApp({
    db,
    config: {
      isE2E: true,
      isProduction: false,
      nodeEnv: "test",
      internalServiceKey: "",
      publicBaseUrl: "http://127.0.0.1",
      sessionSecret: "test-secret-value-for-signing-cookies-1234567890",
      ...configOverride,
    },
    llm: opts.llm,
  });
  await app.ready();
  return { app, db };
}

/** Complete a magic-link sign-in and return the signed session cookie header. */
export async function signIn(
  app: FastifyInstance,
  email: string
): Promise<string> {
  const req = await app.inject({
    method: "POST",
    url: "/auth/magic-link",
    payload: { email },
  });
  if (req.statusCode !== 200) {
    throw new Error(`magic-link failed: ${req.statusCode} ${req.body}`);
  }
  const url = app.e2eLinks?.get(normalizeEmail(email));
  if (!url) throw new Error("no magic link captured");
  const token = new URL(url).searchParams.get("token")!;

  const verify = await app.inject({
    method: "GET",
    url: `/auth/verify?token=${encodeURIComponent(token)}`,
  });
  const cookie = verify.cookies.find((c) => c.name === "atl_session");
  if (!cookie) throw new Error("no session cookie set on verify");
  return `atl_session=${cookie.value}`;
}
