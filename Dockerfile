# syntax=docker/dockerfile:1

# 1) Build both workspaces.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
RUN npm run build

# 2) Backend production dependencies only (no frontend or dev tooling).
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY backend/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

# 3) Slim runtime: built artifacts + backend prod deps only, non-root.
# The app listens on port 80; the staging compose grants unprivileged port
# binding via a namespaced sysctl so no root and no setcap is needed.
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
ENV NODE_ENV=production PORT=80
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/shared ./shared
COPY package.json ./package.json
USER app
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1
CMD ["node", "backend/dist/server.js"]
