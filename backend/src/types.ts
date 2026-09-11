import type { SessionUser } from "./lib/session.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    sessionId?: string;
  }
  interface FastifyInstance {
    e2eLinks?: Map<string, string>;
  }
}

export {};
