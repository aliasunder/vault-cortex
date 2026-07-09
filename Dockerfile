# Multi-stage, two-target build for vault-cortex.
#
#   --target local  (DEFAULT) — tini + MCP server only. Published as
#                   ghcr.io/aliasunder/vault-cortex:latest / :vX.Y.Z.
#   --target remote — s6-overlay supervising obsidian-sync (obsidian-headless
#                   CLI) + the MCP server in one container. Published as
#                   ghcr.io/aliasunder/vault-cortex:remote / :vX.Y.Z-remote.
#
# GOTCHA: better-sqlite3 and onnxruntime-node prebuilds are arch+libc
# specific. Always `npm ci` inside Debian — never copy node_modules
# across libc boundaries.
# GOTCHA: build deps (python3/make/g++) are needed as fallback if
# prebuilds don't exist for your arch. They stay in the build stage.
# GOTCHA: onnxruntime-node (bundled by @huggingface/transformers) needs
# glibc — Alpine's musl has no compatible build. This is why the image
# uses Debian slim instead of Alpine (and why the remote target installs
# obsidian-headless fresh via npm instead of building FROM the Alpine
# obsidian-headless-sync-docker image).

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

# ---------------------------------------------------------------------------
# base: everything shared by the local and remote targets.
# No USER/ENTRYPOINT/CMD here — each target sets its own. npm/npx/corepack
# removal also lives in the targets: local removes them wholesale, but remote
# still needs npm to install obsidian-headless first.
# ---------------------------------------------------------------------------
FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS base
WORKDIR /app
# tini: PID 1 that forwards SIGTERM so SQLite WAL closes cleanly (local
# target; the remote target's s6 /init takes over PID 1 duties there).
# libstdc++6 is pre-installed on Debian slim — no extra install needed.
# node:24-slim ships a `node` user at UID 1000 — the local target runs as it;
# the remote target replaces it with `obsidian` at the same UID/GID.
# apt-get upgrade: applies Debian security fixes at build time, covering
# the window between a Debian security release and the next upstream
# node:24-slim rebuild + digest-pin refresh.
RUN apt-get update -qq && apt-get upgrade -y && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
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
EXPOSE 8000

# ---------------------------------------------------------------------------
# remote: s6-overlay supervises obsidian-sync + vault-mcp in one container.
# Absorbed from aliasunder/obsidian-headless-sync-docker (rootfs/, including
# the get-token helper), adapted from Alpine to Debian.
# ---------------------------------------------------------------------------
FROM base AS remote

ARG S6_OVERLAY_VERSION=3.2.2.0
# Digest-pinned per arch (same posture as the digest-pinned base image):
# release assets on GitHub are mutable like tags, so verifying against a
# .sha256 file from the same origin would only prove transfer integrity.
# When bumping S6_OVERLAY_VERSION, refresh these from the new release's
# .sha256 assets.
ARG S6_NOARCH_SHA256=85848f6baab49fb7832a5557644c73c066899ed458dd1601035cf18e7c759f26
ARG S6_X86_64_SHA256=5a09e2f1878dc5f7f0211dd7bafed3eee1afe4f813e872fff2ab1957f266c7c0
ARG S6_AARCH64_SHA256=50a5d4919e688fafc95ce9cf0055a46f74847517bcf08174bac811de234ec7d2
ARG OBSIDIAN_HEADLESS_VERSION=0.0.12
ARG TARGETARCH

# Install s6-overlay (static binaries — work on glibc and musl alike).
# wget/xz-utils are build-time only and purged after extraction;
# ca-certificates stays (wget needs it here, and keeping it is harmless).
RUN apt-get update -qq && apt-get install -y --no-install-recommends wget ca-certificates xz-utils \
    && S6_ARCH="$(case "${TARGETARCH}" in \
         amd64) echo x86_64;; \
         arm64) echo aarch64;; \
         *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1;; \
       esac)" \
    && S6_ARCH_SHA256="$(case "${TARGETARCH}" in \
         amd64) echo "${S6_X86_64_SHA256}";; \
         arm64) echo "${S6_AARCH64_SHA256}";; \
       esac)" \
    && S6_BASE="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}" \
    && wget -qO /tmp/s6-overlay-noarch.tar.xz "${S6_BASE}/s6-overlay-noarch.tar.xz" \
    && wget -qO /tmp/s6-overlay-${S6_ARCH}.tar.xz "${S6_BASE}/s6-overlay-${S6_ARCH}.tar.xz" \
    && cd /tmp \
    && echo "${S6_NOARCH_SHA256}  s6-overlay-noarch.tar.xz" | sha256sum -c \
    && echo "${S6_ARCH_SHA256}  s6-overlay-${S6_ARCH}.tar.xz" | sha256sum -c \
    && tar -C / -Jxpf s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf s6-overlay-${S6_ARCH}.tar.xz \
    && rm -f /tmp/s6-overlay-*.tar.xz \
    && apt-get purge -y wget xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install the obsidian-headless CLI (`ob`), then drop npm/npx/corepack/yarn —
# only `ob` and `node` run at runtime. The removal is selective (unlike the
# local target's wholesale node_modules removal): obsidian-headless and its
# deps under /usr/local/lib/node_modules must survive.
RUN npm install -g obsidian-headless@${OBSIDIAN_HEADLESS_VERSION} \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Replace the `node` user with `obsidian` at the same UID/GID (1000:1000) —
# the PUID/PGID default, and the same numeric owner as the local target's
# `node` user, so file ownership on existing volumes stays valid across
# targets and upgrades. usermod/groupmod
# (used by init-setup-user for runtime PUID/PGID remapping) ship in Debian's
# essential passwd package. /app and /data were chowned to UID 1000 in base —
# numeric ownership carries over to obsidian.
RUN userdel -r node \
    && groupadd -g 1000 obsidian \
    && useradd -u 1000 -g obsidian -d /home/obsidian -s /bin/sh -m obsidian \
    && mkdir -p /vault /home/obsidian/.config \
    && chown -R obsidian:obsidian /vault /home/obsidian

# s6 service definitions (init chain + svc-obsidian-sync + svc-vault-mcp)
# and the interactive get-token helper (rootfs/usr/local/bin/get-token).
COPY rootfs/ /
RUN chmod +x /usr/local/bin/get-token \
    && chmod +x /etc/s6-overlay/scripts/* \
    && chmod +x /etc/s6-overlay/s6-rc.d/svc-obsidian-sync/run \
       /etc/s6-overlay/s6-rc.d/svc-vault-mcp/run

LABEL org.opencontainers.image.description="Standalone MCP server for Obsidian vaults with bundled Obsidian Sync — hybrid search, structured memory, OAuth 2.1."

# Health reflects the MCP server only. obsidian-sync is supervised by s6 —
# tying container health to a sync crash-loop (e.g. a bad auth token) would
# invite restarts that can't fix the cause.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8000}/healthz`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Stop the container if any init oneshot fails (bad token, failed login) —
# the restart policy owns retry.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2 HOME=/home/obsidian
VOLUME ["/vault", "/data", "/home/obsidian/.config"]
ENTRYPOINT ["/init"]

# ---------------------------------------------------------------------------
# local: the MCP server alone — no Obsidian Sync, no s6. LAST stage on
# purpose: `docker build .` with no --target must produce this target
# (`:latest` semantics). Keep it last.
# ---------------------------------------------------------------------------
FROM base AS local
# The runtime is `node dist/...` only — npm, npx, corepack, and yarn are
# never invoked in this image. Removing them drops their bundled
# dependencies' CVE surface and shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/src/vault-mcp/server.js"]
