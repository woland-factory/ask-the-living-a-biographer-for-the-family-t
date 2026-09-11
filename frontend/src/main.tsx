import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth";
import { App } from "./App";
import "./styles.css";

// Frontend error tracking, only when a DSN was injected at serve time.
const dsn = window.__APP_CONFIG__?.sentryDsn;
if (dsn) {
  void import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: window.__APP_CONFIG__?.environment,
      tracesSampleRate: 0,
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
