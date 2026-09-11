/// <reference types="vite/client" />

interface AppRuntimeConfig {
  sentryDsn: string | null;
  environment: string;
}

interface Window {
  __APP_CONFIG__?: AppRuntimeConfig;
}
