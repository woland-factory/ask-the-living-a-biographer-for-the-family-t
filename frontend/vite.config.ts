import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_ROUTES = ["/auth", "/spaces", "/me", "/healthz"];
const proxyTarget = process.env.API_PROXY ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_ROUTES.map((r) => [r, { target: proxyTarget, changeOrigin: true }])
    ),
  },
});
