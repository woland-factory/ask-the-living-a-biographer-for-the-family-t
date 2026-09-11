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
RUN npm run build

# 2) Production-only dependencies (no dev tooling in the runtime image).
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev

# 3) Slim runtime: built artifacts + prod deps only, non-root.
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache libcap \
  && addgroup -S app && adduser -S -G app app \
  && setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"
ENV NODE_ENV=production PORT=80
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/frontend/dist ./frontend/dist
COPY package.json ./package.json
USER app
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1
CMD ["node", "backend/dist/server.js"]
