# vault-cortex (CLI)

Set up a [Vault Cortex](https://github.com/aliasunder/vault-cortex) MCP server
for your Obsidian vault in one command:

```bash
npx vault-cortex@latest init
```

Vault Cortex is a standalone, remote-capable MCP server that gives any AI
agent hybrid search, task management, structured memory, and read/write
access to your Obsidian vault — including its images, PDFs, canvases,
and data files — see the
[full feature overview](https://github.com/aliasunder/vault-cortex#what-you-get).
The server runs as a Docker container; this CLI scaffolds the config and
manages the container so you don't have to.

![npx vault-cortex init — the interactive setup wizard picks a mode, finds your vault, offers the optional settings, generates the config, and starts the server](https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/demo-cli-init.gif)

## Commands

- [`init`](#init) — interactive setup: scaffold the config, generate the auth
  token, start the server
- [`configure`](#configure) — change optional settings interactively and
  restart to apply them
- [`upgrade`](#upgrade) — pull the latest image and re-create the container;
  your data stays
- [`restart`](#restart) — re-create the container so your `.env` edits take
  effect; no image pull
- [`logs`](#logs) — show the server's logs, live or after the fact
- [`down`](#down) — stop and remove the container; your data stays
- [`get-sync-token`](#get-sync-token) — generate an Obsidian Sync auth token
  for remote setups

Run `npx vault-cortex <command> --help` for all flags.

## init

```bash
npx vault-cortex@latest init
```

What it does:

1. Asks how you want to run it:
   - **Local** — Docker on this machine, your vault folder bind-mounted
   - **Remote** — a VPS with [Obsidian Sync](https://obsidian.md/sync),
     reachable from any device
2. Offers the most common optional settings — memory layer and its folder,
   file tools, semantic search, port, timezone (plus sync direction for
   remote) — press enter to keep the defaults, or pick the ones you want to
   change. Skipped when the target directory already has a `.env` (use
   [`configure`](#configure) instead)
3. Generates a `.env` file with a securely generated `MCP_AUTH_TOKEN`
4. Optionally starts the container and waits for the health check
5. Prints your connection details — the MCP URL, your auth token, and how to
   connect your client

Existing files are never overwritten without asking. During a remote setup,
init offers to run [`get-sync-token`](#get-sync-token) for you when Docker is
available.

Flags:

- `--mode local|remote` — skip the mode prompt
- `--vault-path <path>` — absolute path to your vault (local mode)
- `--dir <path>` — directory to write config files into (default
  `./vault-cortex`)
- `--yes` — non-interactive local setup with defaults; requires `--vault-path`

Non-interactive example:

```bash
npx vault-cortex@latest init --yes --vault-path /path/to/YourVault
```

## configure

Change optional settings on an existing setup:

```bash
npx vault-cortex@latest configure
```

Shows the same settings chooser as [`init`](#init) — memory layer and its
folder, file tools, semantic search, port, timezone (plus sync direction for
remote) — pre-filled with your current values, saves your picks to `.env`,
and offers to restart the container so they take effect. Settings not in the chooser
live in `.env` too: edit the value there, then run [`restart`](#restart).

Use `--dir <path>` if your config isn't in `./vault-cortex`.

## upgrade

Pull the latest image, re-create the container, and verify health:

```bash
npx vault-cortex@latest upgrade
```

Run it from the same directory where you ran `init` — it looks for your
config in `./vault-cortex/.env` (pass `--dir <path>` if you scaffolded
somewhere else).

Safe by design:

- Your vault data, search index, and `.env` settings are preserved across
  upgrades — only the server image is replaced.
- Any edits you've made to `.env` are applied on the way up (`docker restart`
  alone does not re-read env files).

Prefer Docker Compose? The CLI uses `docker run` for simplicity, but the
[deploy guides](https://github.com/aliasunder/vault-cortex/blob/main/deploy/)
include Compose files you can use directly. If you set up with Compose, stick
with Compose for updates too (`docker compose pull && docker compose up -d`)
— the CLI and Compose manage the container independently.

## restart

Re-create the container from your `.env` and verify health:

```bash
npx vault-cortex@latest restart
```

Use it after editing `.env` — settings are only read when the container is
created, so a plain `docker restart` won't pick them up, but this will. Unlike
[`upgrade`](#upgrade), it never pulls a new image: you get the same server
version back, with your current settings applied.

Use `--dir <path>` if your config isn't in `./vault-cortex`.

## logs

Show the server's logs:

```bash
npx vault-cortex@latest logs
```

Flags:

- `--follow` — keep streaming new output until you press ctrl-C
- `--since <time>` — only logs newer than this (e.g. `10m`, `2h`, or a
  timestamp)
- `--dir <path>` — directory containing `.env` (default `./vault-cortex`)

```bash
npx vault-cortex@latest logs --follow --since 10m
```

## down

Stop and remove the container:

```bash
npx vault-cortex@latest down
```

Safe by design: your vault, search index, and `.env` settings all live
outside the container, so nothing is lost. Start again any time with
[`restart`](#restart). Running `down` when nothing is running is fine — it
just tells you there's nothing to stop.

Use `--dir <path>` if your config isn't in `./vault-cortex`.

## get-sync-token

Generate an [Obsidian Sync](https://obsidian.md/sync) auth token — needed for
remote setups — without leaving the CLI:

```bash
npx vault-cortex@latest get-sync-token
```

The command opens the Obsidian login inside Docker. Once you've signed in, it
captures your token and prints it — nothing to dig out of the login output.
Use `--dir <path>` to write the token straight into an existing `.env`
instead:

```bash
npx vault-cortex@latest get-sync-token --dir ./vault-cortex
```

During `init --mode remote`, this flow is offered automatically when Docker
is available.

## Requirements

- Node.js >= 20.12 (only for this CLI — the server itself runs in Docker)
- [Docker](https://docs.docker.com/get-docker/) or a Docker-compatible
  runtime (e.g. OrbStack, Colima, Podman) to run the server — the CLI
  manages the container through the `docker` command

## Docs

- [Local quickstart](https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md)
- [Remote quickstart (VPS + Obsidian Sync)](https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md)
- [Full project README](https://github.com/aliasunder/vault-cortex)
