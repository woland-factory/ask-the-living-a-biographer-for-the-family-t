import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";

export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  app.get("/healthz", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return reply.code(200).send({ status: "ok" });
    } catch {
      return reply.code(503).send({ status: "degraded" });
    }
  });
}
