import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1, // sanctioned shared-host allowance
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
    launchOptions: {
      args: [
        "--no-sandbox",
        // Auto-accept the mic prompt and feed a synthetic audio device so the
        // interview recorder can be driven headlessly.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    // Production build served by the backend. The e2e run uses an in-process
    // Postgres (E2E=1), so no external database is needed.
    command: "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NODE_ENV: "production",
      E2E: "1",
      PORT: String(PORT),
      PUBLIC_BASE_URL: baseURL,
      SESSION_SECRET: "e2e-secret-for-signing-cookies-please-change-1234",
      MAGIC_LINK_TTL_MIN: "15",
      // Seed the demo family so the public /demo bridge has its example.
      SEED_DEMO: "1",
    },
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
