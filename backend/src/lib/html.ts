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

// Hosts the Transformers.js library fetches PUBLIC Whisper model weights from,
// once, then caches in the browser. Only model weights cross the network here.
// The recorded audio never leaves the device: transcription runs on-device in
// a Web Worker.
const MODEL_WEIGHT_HOSTS = [
  "https://huggingface.co",
  "https://*.hf.co",
  "https://cdn-lfs.huggingface.co",
];

/** Build the CSP header for an HTML response. Scripts use a per-request nonce. */
export function buildCsp(nonce: string, config: AppConfig): string {
  const connect = ["'self'", ...MODEL_WEIGHT_HOSTS];
  const sentry = config.sentryDsn ? safeOrigin(config.sentryDsn) : null;
  const umami = config.umamiUrl ? safeOrigin(config.umamiUrl) : null;
  if (sentry) connect.push(sentry);
  if (umami) connect.push(umami);

  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the on-device Whisper wasm backend compile.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    // The transcription worker is a bundled script; blob: covers the bundler's
    // worker strategies.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data:",
    // blob: for local object-URL playback; 'self' for GET /answers/:id/audio.
    "media-src 'self' blob:",
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
