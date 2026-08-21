# Fly.io Quickstart (flyctl recipe)

Run Vault Cortex on [Fly.io](https://fly.io) with five commands — no server
to manage. Fly gives you HTTPS, restarts, and a log stream; Obsidian Sync
keeps your vault current; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client.

Fly has no deploy button, so this guide uses its command-line tool,
`flyctl`, with the [`fly.toml`](./fly.toml) in this directory. The recipe
deploys the `vault-cortex:remote` image — Obsidian Sync and the MCP server
supervised together in **one container** — on one always-on machine with one
persistent volume holding your vault, the search index, and Obsidian Sync's
device state
([how the container is put together →](../../ARCHITECTURE.md#container-startup)).
Prefer your own VPS? Use the [remote quickstart](../remote/) instead.

**Contents** — [Prerequisites](#prerequisites) · [Deploy](#deploy) · [Your URL and token](#your-url-and-token) · [First start](#first-start) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Updating](#updating) · [Restart, stop, delete](#restart-stop-delete) · [Config](#configuration) · [Troubleshooting](#troubleshooting)

## Prerequisites

- A [Fly.io](https://fly.io) account with a payment method on file — Fly
  requires one to deploy a published image. The recipe creates a
  `shared-cpu-1x` machine with 2 GB of memory plus a 5 GB volume; see
  [Fly's pricing](https://fly.io/docs/about/pricing/) for the monthly cost.
- [`flyctl`](https://fly.io/docs/flyctl/install/) installed and logged in
  (`fly auth login`)
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

  Keep the token handy — step 3 below uses it.

## Deploy

**1. Download the config into an empty folder:**

```bash
mkdir vault-cortex && cd vault-cortex
curl -fsSLO https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/fly/fly.toml
```

**2. Create the app** (no deploy yet). `flyctl` asks for an app name and a
region and writes them into `fly.toml`; everything else comes from the file:

```bash
fly launch --copy-config --no-deploy --ha=false
```

**3. Set the secrets** — the values only you know. `--stage` stores them
for the first deploy without starting anything:

```bash
fly secrets set --stage \
  MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  OBSIDIAN_AUTH_TOKEN=<token from Prerequisites> \
  VAULT_NAME="<your vault's name, exactly as it appears in Obsidian Sync>"
```

If your vault uses end-to-end encryption, add `VAULT_PASSWORD=<password>`
to the same command. Set `VAULT_NAME` **before** the first deploy — a
container that starts without a vault name creates an empty vault of its own.

**4. Create the volume** in the region you chose in step 2:

```bash
fly volumes create vault_cortex_storage --region <region> --size 5
```

**5. Deploy:**

```bash
fly deploy --ha=false
```

`--ha=false` keeps it to one machine: the volume can only attach to one, and
Obsidian Sync runs on it.

## Your URL and token

- **URL:** `https://<app-name>.fly.dev` — the name you chose in step 2
  (`fly status` shows it). Your MCP client connects at
  `https://<app-name>.fly.dev/mcp`.
- **Token:** the `MCP_AUTH_TOKEN` you set in step 3. Fly stores secrets
  write-only, so keep your own copy; your MCP client enters it once on the
  consent page.

## First start

The first deploy takes longer than later ones. In order, the container logs
in to Obsidian Sync, registers a device named **vault-cortex**, downloads your
vault, builds the search index, and only then answers health checks and
receives traffic. `fly deploy` waits up to five minutes for the health check;
a large vault can take longer — the machine keeps booting either way (see
[Troubleshooting](#troubleshooting)).

Watch with `fly logs`. Lines prefixed `[obsidian-sync]` are the Sync setup
and download; `[vault-cortex]` lines show the storage layout and the public
URL the container derived (`PUBLIC_URL derived from FLY_APP_NAME`); the
structured JSON lines are the MCP server. `server started` means the app is
about to go live.

## Connect your MCP client

Add a remote MCP server with URL `https://<app-name>.fly.dev/mcp`. Leave
OAuth Client ID and Secret empty; a consent page opens in your browser —
enter your `MCP_AUTH_TOKEN` to approve. Claude Code accepts the URL
directly:

```bash
claude mcp add --scope user --transport http vault-cortex https://<app-name>.fly.dev/mcp
```

Client-by-client details, including the static bearer-token form for CLI
tools, are in the remote quickstart's
[Connect your MCP client](../remote/#connect-your-mcp-client).

## Verify

```bash
curl https://<app-name>.fly.dev/healthz
# → {"ok":true}
```

In Obsidian, **Settings → Sync → Devices** lists one new device named
**vault-cortex**. In your MCP client, run a search — results come from your
vault.

## Updating

From the folder holding your `fly.toml`:

```bash
fly deploy --ha=false
```

Fly pulls the current `:remote` image and replaces the machine; your vault,
search index, and Sync device stay on the volume, so the update is quick and
registers no new device.

Release notes: [GitHub Releases](https://github.com/aliasunder/vault-cortex/releases).

## Restart, stop, delete

- **Restart** — `fly machine restart` (add the machine ID from
  `fly machine list` if prompted). Same machine, same volume.
- **Stop** — `fly scale count 0`. Billing for the machine stops; the volume
  and everything on it stay. `fly scale count 1` brings it back.
- **Delete** — `fly apps destroy <app-name>` removes the app, its machine,
  and its volume. Your vault in Obsidian Sync is untouched — the container
  only held a copy. Remove the **vault-cortex** device from **Settings →
  Sync → Devices** in Obsidian afterwards.

## Configuration

`fly.toml` sets these under `[env]`; edit the file and run
`fly deploy --ha=false` to apply:

| Variable           | Value          | What it does                                                                                                                           |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_ROOT`     | `/persist`     | Where the volume is mounted — the vault, search index, Sync device state, and logs live under it. Leave as is.                         |
| `PORT`             | `8000`         | The port the image listens on. Leave as is.                                                                                            |
| `DEVICE_NAME`      | `vault-cortex` | The device name Obsidian Sync shows for this container.                                                                                |
| `TRUST_PROXY_HOPS` | `2`            | Fly's proxy adds its own address after the visitor's; this lets the server see the visitor's real address in its logs and rate limits. |

Secrets are changed with `fly secrets set KEY=value` (this restarts the
machine):

| Secret                | What it does                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`      | Your MCP client's token. Set a new value to rotate it.                                      |
| `OBSIDIAN_AUTH_TOKEN` | Obsidian Sync login. Re-run `get-sync-token` and set the new value if Sync ever rejects it. |
| `VAULT_NAME`          | The vault this container syncs.                                                             |
| `VAULT_PASSWORD`      | End-to-end encryption password, if your vault has one.                                      |

Optional settings use the same names as the remote quickstart's
[Configuration table](../remote/#configuration) — add them under `[env]`
(or as secrets). The ones that matter most on a hosted instance:

- `EMBEDDING_ENABLED=false` — skips the semantic-search models; search falls
  back to keyword matching and the container fits in much less memory.
- `READONLY_MODE=true` — hides every vault-writing tool.

Don't set `PUBLIC_URL`, `LOG_DIR`, or `VAULT_PATH` — the container derives
them from `STORAGE_ROOT` and Fly's own app-name variable at every start.

Machine size is the `[[vm]]` section of `fly.toml`; volume size grows with
`fly volumes extend` (Fly can grow a volume, never shrink it).

## Troubleshooting

**`fly deploy` failed or the machine keeps restarting.** Run `fly logs` and
look at the last `[obsidian-sync]` lines:

- `OBSIDIAN_AUTH_TOKEN is empty or unset` — the secret wasn't set. Set it
  with `fly secrets set OBSIDIAN_AUTH_TOKEN=<token>`.
- `login was rejected` — the token is stale. Run `get-sync-token` again and
  set the new value.
- `ob sync-setup failed` — the vault name doesn't match Obsidian Sync
  exactly (it is case-sensitive), or the vault is end-to-end encrypted and
  `VAULT_PASSWORD` is missing. Fix the secret; the machine restarts on its
  own.
- `VAULT_NAME is not set` — set it with `fly secrets set VAULT_NAME="<name>"`.

**`fly deploy` reported a failed health check, but `fly logs` shows sync
still running.** The check allows five minutes from machine start; the first
start of a large vault — download plus search-index build — can exceed that.
The machine keeps booting regardless: wait for `server started` in
`fly logs`, then `curl https://<app-name>.fly.dev/healthz`. For very large
vaults, set `EMBEDDING_ENABLED = "false"` under `[env]` for the first deploy
and remove it once the vault has synced.

**A second `vault-cortex` device appeared in Obsidian Sync.** The container
re-registered, which happens when the volume was replaced or the device
state under `/persist/config` was removed. Delete the stale device in
Obsidian; nothing else is needed.

**`The vault is empty but this device has previously synced.`** The
container refused to start because the vault directory on the volume is
empty while the device state says a sync already happened — starting would
push deletions to your other devices. This happens only if something removed
`/persist/vault` by hand. Restore the volume from a snapshot
(`fly volumes snapshots list`), or remove `/persist/config` as well to start
over with a fresh device.
