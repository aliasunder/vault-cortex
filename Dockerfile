# Multi-stage build for vault-mcp.
#
# GOTCHA: better-sqlite3 and onnxruntime-node prebuilds are arch+libc
# specific. Always `npm ci` inside Debian — never copy node_modules
# across libc boundaries.
# GOTCHA: build deps (python3/make/g++) are needed as fallback if
# prebuilds don't exist for your arch. They stay in the build stage.
# GOTCHA: onnxruntime-node (bundled by @huggingface/transformers) needs
# glibc — Alpine's musl has no compatible build. This is why the image
# uses Debian slim instead of Alpine.

FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS deps
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 onnxruntime-node

FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS build
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json sst-env.d.ts ./
COPY src/ ./src/
# Server compile only — cli/ is npm-distributed and never copied into the image.
RUN npm run build:server

FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
WORKDIR /app
# tini: PID 1 that forwards SIGTERM so SQLite WAL closes cleanly.
# libstdc++6 is pre-installed on Debian slim — no extra install needed.
# node:24-slim ships a `node` user at UID 1000 — matches obsidian-sync's
# PUID so both containers can read/write the shared /vault volume.
# apt-get upgrade: applies Debian security fixes at build time, covering
# the window between a Debian security release and the next upstream
# node:24-slim rebuild + digest-pin refresh.
RUN apt-get update -qq && apt-get upgrade -y && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
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
      org.opencontainers.image.description="Standalone MCP server for Obsidian vaults — hybrid search, structured memory, 25 tools + 3 prompts, OAuth 2.1." \
      org.opencontainers.image.source="https://github.com/aliasunder/vault-cortex" \
      org.opencontainers.image.licenses="MIT"
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/src/vault-mcp/server.js"]
