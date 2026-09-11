import type { AppConfig } from "../config.js";

export interface MailLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Send the sign-in link. Never throws to the caller and never logs the email
 * address or token in production. When the Mailer is not configured in dev/e2e
 * we surface the link locally so sign-in still works.
 */
export async function sendMagicLink(opts: {
  email: string;
  url: string;
  config: AppConfig;
  log: MailLogger;
  onLocalLink?: (email: string, url: string) => void;
}): Promise<void> {
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
      }
    } catch {
      // Swallow: the endpoint always answers 200 so we never leak whether an
      // address is known, and a mail hiccup must not surface as a server error.
      log.warn("mailer request failed");
    }
    return;
  }

  // No Mailer configured: local dev / e2e fallback.
  if (config.isE2E) onLocalLink?.(email, url);
  if (!config.isProduction) {
    log.info(`Sign-in link (local only): ${url}`);
  } else {
    log.warn("mailer is not configured; sign-in link was not delivered");
  }
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
