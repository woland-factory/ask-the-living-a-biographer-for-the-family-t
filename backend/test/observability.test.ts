import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { initSentry, sentryEnabled } from "../src/lib/observability.js";
import { buildCsp, renderIndexHtml } from "../src/lib/html.js";

describe("observability wiring is inert without env", () => {
  it("does not enable Sentry when SENTRY_DSN is absent", async () => {
    const config = { ...loadConfig(), sentryDsn: "" };
    const enabled = await initSentry(config);
    expect(enabled).toBe(false);
    expect(sentryEnabled()).toBe(false);
  });

  it("omits the Umami tag when its env is unset and includes it when set", () => {
    const base = { ...loadConfig(), umamiUrl: "", umamiWebsiteId: "" };
    const withoutUmami = renderIndexHtml("<head></head>", "abc", base);
    expect(withoutUmami).not.toContain("data-website-id");

    const withUmami = renderIndexHtml("<head></head>", "abc", {
      ...base,
      umamiUrl: "https://analytics.example/script.js",
      umamiWebsiteId: "site-123",
    });
    expect(withUmami).toContain('data-website-id="site-123"');
    expect(withUmami).toContain('nonce="abc"');
  });

  it("builds a CSP that carries the per-request nonce", () => {
    const csp = buildCsp("nonce-value", loadConfig());
    expect(csp).toContain("script-src 'self' 'nonce-nonce-value'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
