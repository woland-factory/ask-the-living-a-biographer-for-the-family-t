import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const API_ROUTES = ["/auth", "/spaces", "/sessions", "/answers", "/questions", "/me", "/healthz"];
const proxyTarget = process.env.API_PROXY ?? "http://127.0.0.1:8080";

/**
 * Copy the ONNX Runtime Web wasm backend into the build so it is served from
 * our own origin ('self' under CSP), never a third-party CDN. The worker sets
 * wasmPaths to "/ort/". The .wasm files come from node_modules at build time
 * and are never committed to the repo.
 */
function copyOnnxWasm(): Plugin {
  return {
    name: "copy-onnx-wasm",
    apply: "build",
    writeBundle(options) {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve("onnxruntime-web/package.json");
      const dist = path.join(path.dirname(pkg), "dist");
      const outDir = options.dir ?? path.resolve(__dirname, "dist");
      const dest = path.join(outDir, "ort");
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(dist)) {
        // Only the single-threaded builds are usable: threaded ONNX needs
        // SharedArrayBuffer, which needs cross-origin isolation (COOP+COEP)
        // that this app does not set. Shipping them would only bloat the image.
        if (file.endsWith(".wasm") && !file.includes("threaded")) {
          cpSync(path.join(dist, file), path.join(dest, file));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyOnnxWasm()],
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_ROUTES.map((r) => [r, { target: proxyTarget, changeOrigin: true }])
    ),
  },
});
