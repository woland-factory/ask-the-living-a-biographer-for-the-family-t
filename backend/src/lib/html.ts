import type { AppConfig } from "../config.js";

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Build the CSP header for an HTML response. Scripts use a per-request nonce. */
export function buildCsp(nonce: string, config: AppConfig): string {
  const connect = ["'self'"];
  const sentry = config.sentryDsn ? safeOrigin(config.sentryDsn) : null;
  const umami = config.umamiUrl ? safeOrigin(config.umamiUrl) : null;
  if (sentry) connect.push(sentry);
  if (umami) connect.push(umami);

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Inject runtime config (frontend Sentry DSN) and the optional Umami analytics
 * tag into the built index.html. Both are inert when their env is unset.
 */
export function renderIndexHtml(
  template: string,
  nonce: string,
  config: AppConfig
): string {
  const appConfig = {
    sentryDsn: config.sentryDsn || null,
    environment: config.nodeEnv,
  };
  const configScript = `<script nonce="${nonce}">window.__APP_CONFIG__=${JSON.stringify(
    appConfig
  )};</script>`;

  let umami = "";
  if (config.umamiUrl && config.umamiWebsiteId) {
    umami = `<script defer src="${escapeAttr(
      config.umamiUrl
    )}" data-website-id="${escapeAttr(config.umamiWebsiteId)}" nonce="${nonce}"></script>`;
  }

  if (template.includes("</head>")) {
    return template.replace("</head>", `${configScript}${umami}</head>`);
  }
  return `${configScript}${umami}${template}`;
}
