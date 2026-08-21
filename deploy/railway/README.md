# Railway Quickstart (one-click)

Run Vault Cortex on [Railway](https://railway.com) from a button — no server
to manage. Railway gives you HTTPS, restarts, and a log viewer; Obsidian Sync
keeps your vault current; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client.

The button deploys the `vault-cortex:remote` image — Obsidian Sync and the
MCP server supervised together in **one container** — from a published
Railway template, with one persistent volume holding your vault, the search
index, and Obsidian Sync's device state
([how the container is put together →](../../ARCHITECTURE.md#container-startup)).
Prefer your own VPS? Use the [remote quickstart](../remote/) instead.

**Contents** — [Prerequisites](#prerequisites) · [Deploy](#deploy) · [Your URL and token](#your-url-and-token) · [First start](#first-start) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Updating](#updating) · [Restart, stop, delete](#restart-stop-delete) · [Config](#configuration) · [Troubleshooting](#troubleshooting) · [Template definition](#template-definition-maintainers)

## Prerequisites

- A [Railway](https://railway.com) account on the **Hobby** plan or higher —
  the trial plan caps volumes at 0.5 GB, which a typical vault plus its
  search index overflows, and Hobby includes the 5 GB volume this template
  uses. Upgrade **before** deploying: a volume keeps the size of the plan it
  was created on. See
  [Railway's pricing](https://railway.com/pricing); a typical instance uses
  roughly 1–2 GB of memory.
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- Your Obsidian Sync login token. With Node.js >= 20.12 on your computer:

  ```bash
  npx vault-cortex@latest get-sync-token
  ```

  Without Node.js, run the helper in a throwaway container — it prints the
  token and exits:

  ```bash
  docker run --rm -it --entrypoint get-sync-token \
    ghcr.io/aliasunder/vault-cortex:remote
  ```

  Keep the token handy — the deploy form asks for it.

## Deploy

<!-- RAILWAY_TEMPLATE_BUTTON: replaced with the published template's button -->

Railway asks for these values before it creates anything:

| Field                 | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `VAULT_NAME`          | Your vault's name, exactly as it appears in Obsidian Sync            |
| `VAULT_PASSWORD`      | Only if your vault uses end-to-end encryption; otherwise leave empty |
| `OBSIDIAN_AUTH_TOKEN` | The token from [Prerequisites](#prerequisites)                       |

Fill in the token and vault name **before** the first deploy — a container
that starts without a vault name creates an empty vault of its own.

Click **Deploy**. Railway creates the service and volume, pulls the image,
and starts the first deploy. Everything else — the MCP token, the public
URL, the port, the storage layout — is set by the template.

## Your URL and token

- **URL:** open the service, then **Settings → Networking**. The generated
  domain looks like `https://<name>.up.railway.app`; your MCP client
  connects at `https://<name>.up.railway.app/mcp`.
- **Token:** `MCP_AUTH_TOKEN` under the service's **Variables** tab. Railway
  generated it for you; your MCP client enters it once on the consent page.

Railway shows every variable's value in the dashboard. Once you have copied
the token, you can hide the sensitive ones for good: open the **⋮** menu
beside `MCP_AUTH_TOKEN`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_PASSWORD` and
choose **Seal**. A sealed value still reaches the container but can never be
viewed again — to rotate it later, set a new value.

## First start

The first deploy takes longer than later ones. In order, the container logs
in to Obsidian Sync, registers a device named **vault-cortex**, downloads your
vault, builds the search index, and only then answers health checks and
receives traffic. The template allows 15 minutes for this; a large vault can
take most of it.

Watch the service's **Deployments → View logs**. Lines prefixed
`[obsidian-sync]` are the Sync setup and download; `[vault-cortex]` lines
show the storage layout and the public URL the container derived
(`PUBLIC_URL derived from RAILWAY_PUBLIC_DOMAIN`); the structured JSON lines
are the MCP server. `server started` means the deploy is about to go live.

## Connect your MCP client

Add a remote MCP server with URL `https://<name>.up.railway.app/mcp`. Leave
OAuth Client ID and Secret empty; a consent page opens in your browser —
enter your `MCP_AUTH_TOKEN` to approve. Claude Code accepts the URL
directly:

```bash
claude mcp add --scope user --transport http vault-cortex https://<name>.up.railway.app/mcp
```

Client-by-client details, including the static bearer-token form for CLI
tools, are in the remote quickstart's
[Connect your MCP client](../remote/#connect-your-mcp-client).

## Verify

```bash
curl https://<name>.up.railway.app/healthz
# → {"ok":true}
```

In Obsidian, **Settings → Sync → Devices** lists one new device named
**vault-cortex**. In your MCP client, run a search — results come from your
vault.

## Updating

Services deployed from a Docker-image template don't update on their own
unless you turn that on. Either way, your vault, search index, and Sync
device stay on the volume, so an update is quick and registers no new
device.

- **By hand** — open the service, open the latest entry under
  **Deployments**, and choose **Redeploy**. Railway pulls the current
  `:remote` image and restarts the container.
- **Automatically** — **Settings → Source → Configure auto updates**, pick
  **Update to the latest tag**, and choose a maintenance window (weekends,
  overnight, as soon as ready, or custom hours). Railway checks the image
  every few hours and redeploys when `:remote` changes; the container is
  down for under a minute while it restarts.

Release notes: [GitHub Releases](https://github.com/aliasunder/vault-cortex/releases).

## Restart, stop, delete

All from the service page:

- **Restart** — **Deployments → ⋮ → Restart**. Same container, same volume.
- **Stop** — **Deployments → ⋮ → Remove** stops the running deployment; the
  volume and variables stay. **Redeploy** brings it back.
- **Delete** — **Settings → Delete Service**, then delete the volume from the
  project canvas. Your vault in Obsidian Sync is untouched — the container
  only held a copy. Remove the **vault-cortex** device from **Settings →
  Sync → Devices** in Obsidian afterwards.

## Configuration

The template sets these; change them under the service's **Variables** tab
(Railway stages the change and redeploys when you apply it):

| Variable                          | Value          | What it does                                                                                                                                  |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_ROOT`                    | `/persist`     | Where the volume is mounted — the vault, search index, Sync device state, and logs live under it. Leave as is.                                |
| `PORT`                            | `8000`         | The port the image listens on. Leave as is.                                                                                                   |
| `DEVICE_NAME`                     | `vault-cortex` | The device name Obsidian Sync shows for this container.                                                                                       |
| `TRUST_PROXY_HOPS`                | `2`            | Two Railway proxies sit between a visitor and the container; this lets the server see the visitor's real address in its logs and rate limits. |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`          | How long Railway waits for the first health check — the first start downloads the vault and builds the index.                                 |
| `MCP_AUTH_TOKEN`                  | generated      | Your MCP client's token. Change it here to rotate it.                                                                                         |
| `OBSIDIAN_AUTH_TOKEN`             | yours          | Obsidian Sync login. Re-run `get-sync-token` and paste the new value if Sync ever rejects it.                                                 |
| `VAULT_NAME`                      | yours          | The vault this container syncs.                                                                                                               |
| `VAULT_PASSWORD`                  | yours / empty  | End-to-end encryption password, if your vault has one.                                                                                        |

Optional settings use the same names as the remote quickstart's
[Configuration table](../remote/#configuration) — add them as new
variables. The ones that matter most on a hosted instance:

- `EMBEDDING_ENABLED=false` — skips the semantic-search models; search falls
  back to keyword matching and the container fits in much less memory.
- `READONLY_MODE=true` — hides every vault-writing tool.

Don't set `PUBLIC_URL`, `LOG_DIR`, or `VAULT_PATH` — the container derives
them from `STORAGE_ROOT` and Railway's own address variable at every start.

Volume size is changed from the volume's settings on the project canvas
(Railway can grow a volume, never shrink it).

## Troubleshooting

**The first deploy failed.** Open the deployment's logs and look at the last
`[obsidian-sync]` lines:

- `OBSIDIAN_AUTH_TOKEN is empty or unset` — the token wasn't entered. Add it
  under **Variables**, then **Redeploy**.
- `login was rejected` — the token is stale. Run `get-sync-token` again,
  update `OBSIDIAN_AUTH_TOKEN`, then **Redeploy**.
- `ob sync-setup failed` — the vault name doesn't match Obsidian Sync
  exactly (it is case-sensitive), or the vault is end-to-end encrypted and
  `VAULT_PASSWORD` is missing. Fix the variable, then **Redeploy**.
- `VAULT_NAME is not set` — add it under **Variables**, then **Redeploy**.

**The deploy timed out waiting for the health check.** The template allows
15 minutes (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`) from container start. The
first start of a large vault — download plus search-index build — can exceed
that. **Redeploy**: the files and index that already reached the volume are
reused, so the second attempt is much faster. For very large vaults, set
`EMBEDDING_ENABLED=false` for the first deploy and remove it once the vault
has synced.

**The logs repeat `ENOSPC: no space left on device`.** The volume is full.
A volume created on the trial plan is 0.5 GB and stays that size after an
upgrade. Upgrade to Hobby, delete the volume (**Settings → Volumes**), add a
new one at `/persist`, then **Redeploy** — the container registers a fresh
Sync device and downloads the vault again.

**A second `vault-cortex` device appeared in Obsidian Sync.** The container
re-registered, which happens when the volume was replaced or the device
state under `/persist/config` was removed. Delete the stale device in
Obsidian; nothing else is needed.

**`The vault is empty but this device has previously synced.`** The
container refused to start because the vault directory on the volume is
empty while the device state says a sync already happened — starting would
push deletions to your other devices. This happens only if something removed
`/persist/vault` by hand. Restore the volume from a backup (the volume's
**Backups** tab), or remove `/persist/config` as well to start over with a
fresh device.

## Template definition (maintainers)

The Railway template lives in Railway's Template Composer, not in this
repository. Re-creating it from scratch is mechanical — these are its
settings:

| Setting           | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Service name      | `vault-cortex`                                        |
| Source            | Docker image `ghcr.io/aliasunder/vault-cortex:remote` |
| Volume            | mount path `/persist`                                 |
| Public networking | HTTP, port `8000`                                     |
| Healthcheck path  | `/healthz`                                            |
| Restart policy    | On failure (Railway's default)                        |

Variables, in the order the deploy form shows them (the last six sit under **Pre-Configured Environment Variables**, collapsed):

| Variable                          | Value                                 | Description shown on the deploy form                                                                         |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `VAULT_NAME`                      | _(required input)_                    | Your vault's name, exactly as it appears in Obsidian Sync                                                    |
| `VAULT_PASSWORD`                  | _(optional input)_                    | Only if your vault uses end-to-end encryption; otherwise leave empty                                         |
| `OBSIDIAN_AUTH_TOKEN`             | _(required input)_                    | Obsidian Sync login token — run `npx vault-cortex@latest get-sync-token` to get yours                        |
| `MCP_AUTH_TOKEN`                  | `${{secret(64, "0123456789abcdef")}}` | Generated for you — the token your MCP client enters on the consent page                                     |
| `PORT`                            | `8000`                                | The port the image listens on. Leave as is.                                                                  |
| `STORAGE_ROOT`                    | `/persist`                            | Where the volume is mounted — vault, search index, Sync device state, and logs live under it. Leave as is.   |
| `DEVICE_NAME`                     | `vault-cortex`                        | The device name Obsidian Sync shows for this container                                                       |
| `TRUST_PROXY_HOPS`                | `2`                                   | Railway proxies between a visitor and the container, so the server sees the visitor's real address           |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`                                 | How long Railway waits for the first health check — the first start downloads the vault and builds the index |

Update the template whenever the image tag, a boot-required variable, the
port, or the health path changes, then re-publish; existing deployments keep
their settings until their owners redeploy.
