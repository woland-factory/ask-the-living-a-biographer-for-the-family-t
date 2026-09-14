/// <reference types="vite/client" />

interface AppRuntimeConfig {
  sentryDsn: string | null;
  environment: string;
}

interface Window {
  __APP_CONFIG__?: AppRuntimeConfig;
  // Test seam for on-device transcription (e2e only). Inert in production.
  __ATL_TRANSCRIBE__?: "stub" | "fail";
}
