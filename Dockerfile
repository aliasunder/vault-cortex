# Multi-stage build for vault-mcp.
#
# GOTCHA: better-sqlite3 prebuilds are arch+libc specific.
# Always `npm ci` inside Alpine — never copy node_modules across libc.
# GOTCHA: build deps (python3/make/g++) are needed as fallback if
# prebuilds don't exist for your arch. They stay in the build stage.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/vault-mcp ./src/vault-mcp
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
# tini: PID 1 that forwards SIGTERM so SQLite WAL closes cleanly.
# libstdc++: required by better-sqlite3.node native addon on Alpine.
RUN apk add --no-cache tini libstdc++ \
 && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist/src/vault-mcp ./dist/src/vault-mcp
COPY package.json ./
RUN mkdir -p /data && chown -R app:app /data /app
USER app
EXPOSE 8000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/vault-mcp/server.js"]
