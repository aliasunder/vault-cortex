# Multi-stage build for vault-mcp.
#
# GOTCHA: better-sqlite3 prebuilds are arch+libc specific.
# Always `npm ci` inside Alpine — never copy node_modules across libc.
# GOTCHA: build deps (python3/make/g++) are needed as fallback if
# prebuilds don't exist for your arch. They stay in the build stage.

FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json sst-env.d.ts ./
COPY src/ ./src/
# Server compile only — cli/ is npm-distributed and never copied into the image.
RUN npm run build:server

FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS runtime
WORKDIR /app
# tini: PID 1 that forwards SIGTERM so SQLite WAL closes cleanly.
# libstdc++: required by better-sqlite3.node native addon on Alpine.
# node:24-alpine ships a `node` user at UID 1000 — matches obsidian-sync's
# PUID so both containers can read/write the shared /vault volume.
# apk upgrade: applies Alpine security fixes (openssl et al.) at build
# time, covering the window between an Alpine security release and the
# next upstream node:24-alpine rebuild + digest-pin refresh.
RUN apk upgrade --no-cache && apk add --no-cache tini libstdc++
# The runtime is `node dist/...` only — npm, npx, corepack, and yarn are
# never invoked in this image. Removing them drops their bundled
# dependencies' CVE surface and shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0 VAULT_PATH=/vault INDEX_DB_PATH=/data/index.db
# OCI image metadata. The ownership marker must match `name` in server.json
# (mcp-publisher reads it off the manifest). title/description/source/licenses
# show via `docker inspect` and on the GHCR package page; for the multi-arch
# manifest list GHCR takes the displayed description from the *index* annotation
# set in deploy.yml — keep that description and the one here in sync.
LABEL io.modelcontextprotocol.server.name="io.github.aliasunder/vault-cortex" \
      org.opencontainers.image.title="vault-cortex" \
      org.opencontainers.image.description="MCP server for Obsidian vaults — search, memory, link graph, 23 tools, OAuth-protected." \
      org.opencontainers.image.source="https://github.com/aliasunder/vault-cortex" \
      org.opencontainers.image.licenses="MIT"
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/vault-mcp/server.js"]
