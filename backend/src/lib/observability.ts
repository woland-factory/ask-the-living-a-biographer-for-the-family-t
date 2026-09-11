import type { AppConfig } from "../config.js";

let enabled = false;

/**
 * Initialize backend error tracking only when SENTRY_DSN is set. Completely
 * inert (and never throws) when the DSN is absent.
 */
export async function initSentry(config: AppConfig): Promise<boolean> {
  if (!config.sentryDsn) {
    enabled = false;
    return false;
  }
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.nodeEnv,
      // Do not attach request bodies / headers that may carry PII or tokens.
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
    enabled = true;
    return true;
  } catch {
    enabled = false;
    return false;
  }
}

export function sentryEnabled(): boolean {
  return enabled;
}

export async function reportError(err: unknown): Promise<void> {
  if (!enabled) return;
  try {
    const Sentry = await import("@sentry/node");
    Sentry.captureException(err);
  } catch {
    // ignore
  }
}
