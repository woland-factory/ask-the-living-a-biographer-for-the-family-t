import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { copy } from "./lib/copy.js";
import { buildCsp, renderIndexHtml } from "./lib/html.js";
import { reportError } from "./lib/observability.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSpaceRoutes } from "./routes/spaces.js";
import "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveStaticDir(config: AppConfig): string {
  return config.staticDir ?? path.resolve(here, "../../frontend/dist");
}

const FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ask the Living</title></head><body><div id="root"><main><h1>Remember them together.</h1><p>Loading.</p></main></div></body></html>`;

export interface BuildAppOptions {
  db: Db;
  config?: Partial<AppConfig>;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const config: AppConfig = { ...loadConfig(), ...opts.config };
  const db = opts.db;

  const app = Fastify({
    logger: config.isE2E
      ? false
      : {
          level: process.env.LOG_LEVEL ?? "info",
          // Never let request bodies (which carry emails/tokens) into logs.
          redact: {
            paths: ["req.headers.cookie", "req.headers.authorization"],
            remove: true,
          },
        },
    // The verify URL carries a one-time token in its query string; automatic
    // request logging would write it to the logs. Log deliberately instead.
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 32 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: copy.rateLimit,
    }),
  });

  // Validation and error shaping: safe, product-voice messages only.
  app.setErrorHandler(async (err: import("fastify").FastifyError, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: copy.validation });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ error: copy.rateLimit });
    }
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      await reportError(err);
      return reply.code(500).send({ error: copy.generic });
    }
    return reply.code(status).send({ error: err.message || copy.generic });
  });

  const e2eLinks = config.isE2E ? new Map<string, string>() : undefined;
  if (e2eLinks) app.decorate("e2eLinks", e2eLinks);

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, { db, config, e2eLinks });
  registerSpaceRoutes(app, db);

  // Serve the built SPA and provide a same-origin fallback for client routes.
  const staticDir = resolveStaticDir(config);
  const indexPath = path.join(staticDir, "index.html");
  const template = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : FALLBACK_HTML;

  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      index: false,
      wildcard: false,
    });
  }

  const serveApp = (reply: import("fastify").FastifyReply) => {
    const nonce = randomBytes(16).toString("base64");
    reply.header("Content-Security-Policy", buildCsp(nonce, config));
    return reply.type("text/html").send(renderIndexHtml(template, nonce, config));
  };

  app.get("/", async (_req, reply) => serveApp(reply));

  app.setNotFoundHandler((req, reply) => {
    const accept = String(req.headers.accept ?? "");
    if (req.method === "GET" && accept.includes("text/html")) {
      return serveApp(reply);
    }
    return reply.code(404).send({ error: copy.notFound });
  });

  return app;
}
