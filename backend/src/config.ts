export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  isE2E: boolean;
  port: number;
  publicBaseUrl: string;
  sessionSecret: string;
  magicLinkTtlMin: number;
  sessionTtlDays: number;
  mailerUrl: string;
  internalServiceKey: string;
  mailFromName: string;
  sentryDsn: string;
  umamiUrl: string;
  umamiWebsiteId: string;
  seedDemo: boolean;
  staticDir: string | null;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== "" ? n : fallback;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    isE2E: process.env.E2E === "1",
    port: num(process.env.PORT, 8080),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
    // A signing secret is always required. In production it must come from env;
    // the dev default keeps local runs working without setup.
    sessionSecret:
      process.env.SESSION_SECRET ??
      "dev-only-insecure-session-secret-please-change-me",
    magicLinkTtlMin: num(process.env.MAGIC_LINK_TTL_MIN, 15),
    sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 30),
    mailerUrl:
      process.env.MAILER_URL ?? "http://central-mailer-prod-api:8000/send",
    internalServiceKey: process.env.INTERNAL_SERVICE_KEY ?? "",
    mailFromName: process.env.MAIL_FROM_NAME ?? "Ask the Living",
    sentryDsn: process.env.SENTRY_DSN ?? "",
    umamiUrl: process.env.UMAMI_URL ?? "",
    umamiWebsiteId: process.env.UMAMI_WEBSITE_ID ?? "",
    seedDemo: process.env.SEED_DEMO === "1",
    staticDir: process.env.STATIC_DIR ?? null,
  };
}
