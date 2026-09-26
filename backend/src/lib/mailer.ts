import type { AppConfig } from "../config.js";

export interface MailLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Send the sign-in link. Never throws to the caller and never logs the email
 * address or token. When the Mailer is not configured in dev/e2e we surface the
 * link locally so sign-in still works.
 *
 * Returns true when the link was delivered (or surfaced locally in dev/e2e),
 * false when delivery is structurally impossible or hard-fails. The failure is
 * identical for every address, so the caller can report it to all callers alike
 * without leaking whether an address is known.
 */
export async function sendMagicLink(opts: {
  email: string;
  url: string;
  config: AppConfig;
  log: MailLogger;
  onLocalLink?: (email: string, url: string) => void;
}): Promise<boolean> {
  const { email, url, config, log, onLocalLink } = opts;

  if (config.internalServiceKey) {
    try {
      const res = await fetch(config.mailerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Key": config.internalServiceKey,
        },
        body: JSON.stringify({
          to: email,
          subject: "Your sign-in link",
          from_name: config.mailFromName,
          html_content: renderEmail(url, config.mailFromName),
        }),
      });
      if (!res.ok) {
        log.warn(`mailer responded with status ${res.status}`);
        return false;
      }
      return true;
    } catch {
      // A mail hiccup must not surface as a server error, and the log carries
      // no address or token. The caller turns this into an honest failure.
      log.warn("mailer request failed");
      return false;
    }
  }

  // No Mailer configured. The e2e suite reads the link back through a test-only
  // endpoint, so sign-in still completes; treat it as delivered.
  if (config.isE2E) {
    onLocalLink?.(email, url);
    return true;
  }
  if (!config.isProduction) {
    log.info(`Sign-in link (local only): ${url}`);
    return true;
  }

  // Production with no Mailer configured: we cannot send. Say so honestly.
  log.warn("mailer is not configured; sign-in link was not delivered");
  return false;
}

function renderEmail(url: string, fromName: string): string {
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; color: #2a2a2a; line-height: 1.5;">
    <p>Here is your link to sign in to ${escapeHtml(fromName)}.</p>
    <p><a href="${safeUrl}">Sign in</a></p>
    <p>The link works for a short while. If you did not ask for it, you can ignore this email.</p>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
