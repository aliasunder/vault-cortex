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

**Contents** — [Prerequisites](#prerequisites) · [Deploy](#deploy) · [Your URL and token](#your-url-and-token) · [Security](#security) · [First start](#first-start) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Updating](#updating) · [Restart, stop, delete](#restart-stop-delete) · [Config](#configuration) · [Troubleshooting](#troubleshooting) · [Template definition](#template-definition-maintainers)

## Prerequisites

- A [Railway](https://railway.com) account on the **Hobby** plan or higher —
  the trial plan caps volumes at 0.5 GB, which a typical vault plus its
  search index overflows, and Hobby includes the 5 GB volume this template
  uses. Upgrade **before** deploying: a volume keeps the size of the plan it
  was created on. See
  [Railway's pricing](https://railway.com/pricing); a typical instance uses
  roughly 1–2 GB of memory.
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- Your Obsidian Sync login token — see
  [Getting your Obsidian Sync token](#getting-your-obsidian-sync-token)
  below. It is the one step that happens on your own computer.

### Getting your Obsidian Sync token

The token lets the container log in to Obsidian Sync as you. Obsidian only
hands it out after an interactive login, so this step runs in a terminal on
your computer — once, before you click the button.

1. **Open a terminal.** macOS: **Applications → Utilities → Terminal**.
   Windows: search the Start menu for **Terminal** (or **PowerShell**).
2. **Install Node.js** if you don't have it: download the LTS installer from
   [nodejs.org](https://nodejs.org) and run it. (Already have Docker but not
   Node? See the alternative below.)
3. **Paste this line and press Enter:**

   ```bash
   npx vault-cortex@latest get-sync-token
   ```

   It asks for your Obsidian account email, password, and two-factor code
   (if you use one), prints the token, and exits. Nothing is installed
   permanently.

4. **Copy the token.** The deploy form asks for it as `OBSIDIAN_AUTH_TOKEN`.

With Docker instead of Node.js, the same helper runs in a throwaway
container:

```bash
docker run --rm -it --entrypoint get-sync-token \
  ghcr.io/aliasunder/vault-cortex:remote
```

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/vault-cortex?referralCode=_ldHIU&utm_medium=integration&utm_source=template&utm_campaign=generic)

The button opens the template's page. Click **Deploy Now**, then
**Configure** on the `vault-cortex` service card to open the form. Two of
its fields are required and two are optional:

| Field                 | Value                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                  | Your timezone as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) (`America/Toronto`) — decides what "today" means for daily notes, task due dates, and memory timestamps. Leave empty for UTC |
| `VAULT_NAME`          | Your vault's name, exactly as it appears in Obsidian Sync                                                                                                                                                                       |
| `VAULT_PASSWORD`      | Only if your vault uses end-to-end encryption; otherwise leave empty                                                                                                                                                            |
| `OBSIDIAN_AUTH_TOKEN` | The token from [Getting your Obsidian Sync token](#getting-your-obsidian-sync-token)                                                                                                                                            |

Fill in the token, vault name, and timezone **before** the first deploy — a container
that starts without the token or the vault name stops at Obsidian Sync setup.

Click **Deploy**. Railway creates the service and volume, pulls the image,
and starts the first deploy. Everything else — the MCP token, the public
URL, the port, the storage layout — is set by the template.

## Your URL and token

- **URL:** open the service, then **Settings → Networking**. The generated
  domain looks like `https://<name>.up.railway.app`; your MCP client
  connects at `https://<name>.up.railway.app/mcp`.
- **Token:** click the `vault-cortex` card on the project canvas, open
  **Variables**, and use the eye or copy icon beside `MCP_AUTH_TOKEN`.
  Railway generated it for you; your MCP client enters it once on the
  consent page.

## Security

Out of the box, every request to your instance travels over HTTPS to
Railway's edge and is checked by the server before any vault data moves:

- **HTTPS everywhere.** Railway provisions and renews the certificate and
  terminates TLS at its edge; the container is never reachable directly.
- **Nothing without the token.** `/mcp` answers `401` to any request that
  lacks a valid token. OAuth clients get one through the consent page (full
  OAuth 2.1 with PKCE and refresh-token rotation); scripts send
  `MCP_AUTH_TOKEN` as a bearer header. The login, registration, and token
  endpoints are rate-limited per visitor address — `TRUST_PROXY_HOPS=2` is
  what lets the server see that address through Railway's proxies.
- **Encrypted at rest.** The volume holding your vault, index, and Sync
  device state is encrypted by Railway
  ([Trust Center](https://trust.railway.com)).
- **Logs carry no secrets.** The server logs note paths, headings, search
  queries, and error text — your vault's own metadata — never tokens,
  passwords, or note bodies.

What the server can't protect is the Railway account that holds it: anyone
who can open this project in the dashboard can read the variables, the logs,
and the volume. Four steps close that, all from the dashboard:

1. **Seal the secrets** once you have copied `MCP_AUTH_TOKEN`. Values are
   masked in the dashboard, but anyone with access can reveal them with the
   eye icon; sealing makes that impossible. Open the **⋮** menu beside
   `MCP_AUTH_TOKEN`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_PASSWORD` and choose
   **Seal**. A sealed value still reaches the
   container but can never be viewed again — to rotate it later, set a new
   value. These are the credentials that grant access to your vault.
2. **Turn on two-factor authentication** for your Railway account
   (profile photo → **Account Settings → Account Security**).
3. **Keep the project to yourself.** Workspace members you invite can reveal
   unsealed variables and read every log line, search queries included.
4. **Schedule volume backups** (open the volume on the project canvas →
   **Backups**). A daily schedule keeps six days; restoring is one click.

Optional settings narrow what a connected client can do — change them
under **Variables**: `READONLY_MODE=true` removes every tool that writes to
the vault, and `FILE_TOOLS_ENABLED=false` or `MEMORY_ENABLED=false` hide
those tool groups entirely (see [Configuration](#configuration)).

Rotating `MCP_AUTH_TOKEN` invalidates the access tokens issued under it;
clients that still hold a refresh token reconnect on their own, so remove
the server from a client you no longer trust rather than relying on
rotation alone. The full attack-surface inventory is in
[SECURITY.md](../../SECURITY.md).

## First start

The first deploy takes longer than later ones. In order, the container logs
in to Obsidian Sync, registers a device named **vault-cortex**, downloads your
vault, builds the search index, and only then answers health checks and
receives traffic. A vault of a few thousand notes takes about three
minutes; the template allows 15, and a large vault can take most of it.

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

In your MCP client, run a search — results come from your vault.

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
  only held a copy.

## Configuration

The template sets these; change them under the service's **Variables** tab
(Railway stages the change and redeploys when you apply it):

| Variable                          | Value           | What it does                                                                                                                                  |
| --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_ROOT`                    | `/persist`      | Where the volume is mounted — the vault, search index, Sync device state, and logs live under it. Leave as is.                                |
| `PORT`                            | `8000`          | The port the image listens on. Leave as is.                                                                                                   |
| `DEVICE_NAME`                     | `vault-cortex`  | The device name that labels this container's changes in Obsidian's sync log.                                                                  |
| `TRUST_PROXY_HOPS`                | `2`             | Two Railway proxies sit between a visitor and the container; this lets the server see the visitor's real address in its logs and rate limits. |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`           | How long Railway waits for the first health check — the first start downloads the vault and builds the index.                                 |
| `MCP_AUTH_TOKEN`                  | generated       | Your MCP client's token. Change it here to rotate it.                                                                                         |
| `OBSIDIAN_AUTH_TOKEN`             | yours           | Obsidian Sync login. Re-run `get-sync-token` and paste the new value if Sync ever rejects it.                                                 |
| `VAULT_NAME`                      | yours           | The vault this container syncs.                                                                                                               |
| `VAULT_PASSWORD`                  | yours / empty   | End-to-end encryption password, if your vault has one.                                                                                        |
| `TZ`                              | yours / empty   | Timezone for daily notes, task due dates, and memory timestamps. Empty means UTC.                                                             |
| `MEMORY_ENABLED`                  | `true`          | The About Me/ memory layer and its tools. Set `false` to hide them and skip creating the folder.                                              |
| `EMBEDDING_ENABLED`               | `true`          | Semantic search. Set `false` to skip the models and use keyword search only — the container fits in much less memory.                         |
| `READONLY_MODE`                   | `false`         | Set `true` to hide every tool that changes the vault — clients can only read and search.                                                      |
| `FILE_TOOLS_ENABLED`              | `true`          | `vault_read_file` and `vault_list_files`. Set `false` when Obsidian Sync has attachment syncing off.                                          |
| `SYNC_MODE`                       | `bidirectional` | Sync direction: `bidirectional`, `pull-only`, or `push-only`.                                                                                 |

The last five are the settings most worth changing on a hosted instance;
the template pre-fills them with the image defaults so you can edit them in
place. Every other optional setting uses the same names as the remote
quickstart's [Configuration table](../remote/#configuration) — add it as a
new variable.

Don't set `PUBLIC_URL`, `LOG_DIR`, or `VAULT_PATH` — the container derives
them from `STORAGE_ROOT` and Railway's own address variable at every start.

Railway's **Serverless** toggle (**Settings → Deploy**) saves nothing here:
it sleeps a service only after ten minutes without outbound traffic, and the
Obsidian Sync connection never goes quiet, so the container stays up and
billed either way.

Volume size is changed from the volume's settings on the project canvas
(Railway can grow a volume, never shrink it).

## Troubleshooting

**The first deploy failed.** Open the deployment's logs and look at the last
`[obsidian-sync]` lines:

- `OBSIDIAN_AUTH_TOKEN is empty or unset` — the token wasn't entered. Add it
  under **Variables**, then **Redeploy**.
- `login was rejected` — the token is stale. Run `get-sync-token` again,
  update `OBSIDIAN_AUTH_TOKEN`, then **Redeploy**.
- `Password not provided.` then `ob sync-setup failed` — the vault is
  end-to-end encrypted and `VAULT_PASSWORD` is missing. Add it under
  **Variables**, then **Redeploy**.
- `ob sync-setup failed` on its own — the vault name doesn't match Obsidian
  Sync exactly (it is case-sensitive). Fix `VAULT_NAME`, then **Redeploy**.
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

**The logs show a fresh Obsidian Sync login and a full vault download on a
redeploy.** The container registered itself as a new device, which happens
when the volume was replaced or the device state under `/persist/config` was
removed. Nothing needs cleaning up — the old registration simply stops
syncing.

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

Variables, in the order the deploy form shows them (everything after the four inputs sits under **Pre-Configured Environment Variables**, collapsed):

| Variable                          | Value                                 | Description shown on the deploy form                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                              | _(optional input)_                    | Your timezone as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) (`America/Toronto`) — decides what "today" means for daily notes, task due dates, and memory timestamps. Leave empty for UTC |
| `VAULT_NAME`                      | _(required input)_                    | Your vault's name, exactly as it appears in Obsidian Sync                                                                                                                                                                       |
| `VAULT_PASSWORD`                  | _(optional input)_                    | Only if your vault uses end-to-end encryption; otherwise leave empty                                                                                                                                                            |
| `OBSIDIAN_AUTH_TOKEN`             | _(required input)_                    | Obsidian Sync login token — run `npx vault-cortex@latest get-sync-token` to get yours                                                                                                                                           |
| `MCP_AUTH_TOKEN`                  | `${{secret(64, "0123456789abcdef")}}` | Generated for you — the token your MCP client enters on the consent page                                                                                                                                                        |
| `PORT`                            | `8000`                                | The port the image listens on. Leave as is.                                                                                                                                                                                     |
| `STORAGE_ROOT`                    | `/persist`                            | Where the volume is mounted — vault, search index, Sync device state, and logs live under it. Leave as is.                                                                                                                      |
| `DEVICE_NAME`                     | `vault-cortex`                        | The device name that labels this container's changes in Obsidian's sync log                                                                                                                                                     |
| `TRUST_PROXY_HOPS`                | `2`                                   | Railway proxies between a visitor and the container, so the server sees the visitor's real address                                                                                                                              |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`                                 | How long Railway waits for the first health check — the first start downloads the vault and builds the index                                                                                                                    |
| `MEMORY_ENABLED`                  | `true`                                | The About Me/ memory layer and its tools. Set false to hide them and skip creating the folder                                                                                                                                   |
| `EMBEDDING_ENABLED`               | `true`                                | Semantic search. Set false to skip the models and use keyword search only — fits in much less memory                                                                                                                            |
| `READONLY_MODE`                   | `false`                               | Set true to hide every tool that changes the vault — clients can only read and search                                                                                                                                           |
| `FILE_TOOLS_ENABLED`              | `true`                                | vault_read_file and vault_list_files. Set false when Obsidian Sync has attachment syncing off                                                                                                                                   |
| `SYNC_MODE`                       | `bidirectional`                       | Sync direction: bidirectional, pull-only, or push-only                                                                                                                                                                          |

Update the template whenever the image tag, a boot-required variable, the
port, or the health path changes, then re-publish; existing deployments keep
their settings until their owners redeploy.
