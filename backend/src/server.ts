import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { initSentry } from "./lib/observability.js";
import { seedDemo } from "./seed.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await initSentry(config);

  const db = await createDb();

  const log = { info: (m: string) => console.log(m) };
  await runMigrations(db, undefined, log);
  if (config.seedDemo) {
    await seedDemo(db, log);
  }

  const app = await buildApp({ db });

  const close = async () => {
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  console.error("failed to start server", err);
  process.exit(1);
});
