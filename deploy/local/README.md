# Local Quickstart

Run Vault Cortex on your machine against a local Obsidian vault. No cloud, no
Obsidian Sync — just Docker and a folder of `.md` files.

**Contents** — [Prerequisites](#prerequisites) · [Setup](#setup) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Monitoring](#monitoring) · [Updating](#updating) · [Restart](#restart) · [Stop](#stop) · [More than one vault](#run-more-than-one-vault) · [Windows](#windows-docker-desktop) · [Memory](#memory) · [File Tools](#file-tools) · [Read-only](#read-only-mode) · [Deleting](#deleting-notes-and-files) · [Daily Notes](#daily-notes) · [Config](#configuration) · [Troubleshooting](#troubleshooting)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10+)
- Node.js >= 22.12 — only for the CLI setup below; the
  [manual setup](#setup) needs just Docker
- An Obsidian vault (or any folder of Markdown files)

## Setup

```bash
npx vault-cortex@latest init
```

The CLI asks for your vault path, generates the auth token and config files,
starts the server, and prints the connection details for your MCP client
([CLI reference →](../../cli/)).

What happens on first start:

- The image is pulled (~150MB)
- The keyword index builds in seconds — search works right away
- The semantic (embedding) index builds in the background — expect a few
  minutes on a large vault; keyword search works meanwhile, and semantic
  matches appear as each note is embedded

> **On Windows?** Set `WINDOWS_MODE=true` in your `.env` — then `VAULT_PATH` can point
> at a normal Windows path like `C:\Users\you\MyVault`. With the CLI, edit the
> generated `.env` after `init` and apply with `npx vault-cortex@latest restart`. See
> [Windows (Docker Desktop)](#windows-docker-desktop) below.

<details>
<summary><strong>Manual setup</strong> (no Node.js needed)</summary>

**1. Get the files.** Download this directory, or clone the repo and `cd deploy/local`.

**2. Create your `.env` file:**

```bash
cp .env.example .env
```

**3. Fill in the two required values:**

| Variable         | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN` | Generate with `openssl rand -hex 32`                                                                  |
| `VAULT_PATH`     | Absolute path to your vault (e.g. `/Users/you/Documents/MyVault`). Must not contain `*`, `?`, or `[`. |

**4. Start the server:**

```bash
docker compose up
```

Add `-d` to run in the background.

</details>

## Connect your MCP client

The server listens at `http://localhost:8000/mcp`.

- "Remote" refers to the connection type (HTTP, as opposed to a stdio process
  the client launches itself) — this server still runs entirely on your
  machine, and only this machine can reach it.
- Claude Mobile and claude.ai web can't reach localhost — use the
  [remote quickstart](../remote/) for access from other devices. To connect
  apps on other computers in your home network, see
  [Other computers on your network](#other-computers-on-your-network).

### Claude Code

1. Add the server:

   ```bash
   claude mcp add --scope user --transport http vault-cortex http://localhost:8000/mcp
   ```

   `--scope user` registers it for every project; drop it to scope the server
   to the current directory only.

2. Approve the consent page with your `MCP_AUTH_TOKEN` (a browser tab opens
   automatically).
3. Done. The client receives auto-refreshing access tokens, so the token
   itself never sits in client config.

### Claude Desktop

The "Add custom connector" dialog only accepts `https` URLs, so a localhost
server can't be added there. Register it in `claude_desktop_config.json`
(Settings → Developer → Edit Config) through
[mcp-remote](https://github.com/geelen/mcp-remote) — a small helper that lets
Claude Desktop talk to a local HTTP server:

```json
{
  "mcpServers": {
    "vault-cortex": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8000/mcp",
        "--header",
        "Authorization: Bearer <your MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

On Windows, spaces inside `args` can be mangled — move the header value into
an env var instead: `"--header", "Authorization:${AUTH_HEADER}"` with
`"env": { "AUTH_HEADER": "Bearer <your MCP_AUTH_TOKEN>" }`.

### Other OAuth clients (Cursor and most MCP clients)

1. Add `http://localhost:8000/mcp` as a remote MCP server, leaving OAuth
   Client ID and Secret empty.
2. A consent page opens in your browser — approve with your `MCP_AUTH_TOKEN`.
3. Done. The client receives auto-refreshing access tokens, so the token
   itself never sits in client config.

### Bearer token (MCP Inspector, scripts, clients without OAuth)

Enter `http://localhost:8000/mcp` as the server URL and your token as the
Bearer token.

**curl:**

```bash
curl -H "Authorization: Bearer <your-token>" http://localhost:8000/mcp
```

### Other computers on your network

Apps on another computer in your home network, such as Claude Code, can
connect once this server accepts connections from that network. Claude Mobile
and claude.ai web still need the [remote quickstart](../remote/).

1. Find this computer's address on your network, such as `192.168.1.20`:
   on macOS, System Settings → Wi-Fi → Details → TCP/IP; on Windows,
   Settings → Network & internet → your connection's properties (IPv4
   address); on Linux, `hostname -I`.
2. In `.env`, set `BIND_ADDRESS=0.0.0.0`. The server then accepts
   connections from your network as well as from this computer.
3. In `.env`, set `PUBLIC_URL` to the address from step 1 with the port, such as
   `PUBLIC_URL=http://192.168.1.20:8000`.
4. Apply both changes. Set up with the CLI? Run
   `npx vault-cortex@latest restart` from the folder you ran `init` in. Set
   up with Docker Compose? Run `docker compose up -d`.
5. Connect MCP clients to `http://192.168.1.20:8000/mcp`, using your own
   address:
   - Clients that sign in with OAuth use that address on this computer too,
     because sign-in works only at the `PUBLIC_URL` address.
   - Clients on this computer that send your `MCP_AUTH_TOKEN` in a header
     can stay on `http://localhost:8000/mcp`.
   - For Claude Desktop on another computer, add `"--allow-http"` to
     mcp-remote's `args`: it refuses `http` addresses other than localhost
     without it.

Anyone on that network can now open the server's OAuth consent page, and your
`MCP_AUTH_TOKEN` is what keeps them out. Connections are plain `http`, so do
this only on a network you trust.

## Verify

```bash
# Health check (no auth required):
curl http://localhost:8000/healthz
# → {"ok":true}

# OAuth discovery (no auth required — root and RFC 9728 path-suffixed forms):
curl http://localhost:8000/.well-known/oauth-protected-resource
curl http://localhost:8000/.well-known/oauth-protected-resource/mcp

# Server logs (structured JSON lines):
npx vault-cortex@latest logs   # set up with the CLI (run from your init directory)
docker logs vault-cortex       # Compose or docker run
```

## Monitoring

```bash
# Follow the server logs until ctrl-C:
npx vault-cortex@latest logs --follow   # set up with the CLI
docker logs -f vault-cortex             # Compose or docker run

# Container status — "healthy" tracks the server's /healthz:
docker ps
```

## Updating

Update with the same method you set up with — the CLI and Compose manage the
container independently.

**Set up with the CLI?**

```bash
npx vault-cortex@latest upgrade
```

Run it from the same directory where you ran `init` — it pulls the new image
and re-creates the container for you. Nothing is deleted — see
[`upgrade`](../../cli/#upgrade) in the CLI reference for what's preserved
and the `--dir` flag.

**Set up with Docker Compose?** Compose does **not** pull new images on
`up`, so pull explicitly:

```bash
docker compose pull && docker compose up -d
```

## Restart

The server runs these startup tasks on every boot:

1. Create memory template files if the memory folder doesn't exist (skipped
   when `MEMORY_ENABLED=false` or `READONLY_MODE=true`).
2. Start the file watcher, which holds the changes it sees until step 4.
3. Rebuild the search index, including any new memory template files.
4. Apply the changes the watcher held, so search reflects notes added, edited
   or deleted while the server started.

Restarting the container re-runs this flow (useful when testing bootstrap
behavior). The command is the same for both setup methods, since both name
the container after `INSTANCE_NAME` (`vault-cortex` unless you set it):

```bash
docker restart vault-cortex
```

> **Changed `.env`?** A restart does **not** re-read `.env` — the container
> has to be re-created. Set up with the CLI? Run
> [`npx vault-cortex@latest restart`](../../cli/#restart) — unlike
> `docker restart`, it re-creates the container, so your edits take effect
> ([`upgrade`](../../cli/#upgrade) also applies `.env` edits and pulls the
> latest image on the way). Using Compose? Run `docker compose up -d` — it
> re-creates services whose configuration changed.

The container also restarts automatically on crash (`restart: unless-stopped`
policy), Docker daemon restart, or system reboot.

## Stop

```bash
# Stop and remove the container (data persists in Docker volumes):
npx vault-cortex@latest down   # set up with the CLI
docker compose down            # Compose

# Stop and delete all volumes (rebuilds the index; reconnect each MCP client):
docker compose down -v         # Compose

# Stop without removing (any setup method; docker start resumes):
docker stop vault-cortex
```

**Set up with the CLI?** Start again any time with
`npx vault-cortex@latest start` — your saved settings are reused
([`down`](../../cli/#down) · [`start`](../../cli/#start) in the CLI
reference). Otherwise resume with `docker compose up -d` or
`docker start vault-cortex`.

## Run more than one vault

Each vault gets its own install, with its own folder, `.env`, container,
search index, port and connector. Give every install after the first its own
`INSTANCE_NAME` before its first start. Docker uses that name for the
install's container and for the volume that holds its search index
(`<name>_mcp_data`); the first install keeps the default, `vault-cortex`.

**Set up with the CLI?** Start Docker, so `init` can check which names and
ports are in use. Then, from the folder you ran `init` in the first time, run it again
with a new `--dir`:

```bash
npx vault-cortex@latest init --dir ./vault-cortex-work
```

When this machine already has a `vault-cortex` container or search index
volume, `init` asks for the new install's name and port, for example `work`
and `8001`. It suggests the first port no other container uses, and points
the install's `PUBLIC_URL` at the port you pick. For a scripted setup,
add `--yes --vault-path <path> --instance-name work --port 8001`. Then pass
the same `--dir` to every command for that install:

```bash
npx vault-cortex@latest upgrade --dir ./vault-cortex-work
npx vault-cortex@latest logs --dir ./vault-cortex-work
```

**Set up with Docker Compose?** Set up a new folder as in **Manual setup**
under [Setup](#setup), with its own `MCP_AUTH_TOKEN` and `VAULT_PATH`. In its
`.env`, also set a new `INSTANCE_NAME` and a free `PORT`, and point
`PUBLIC_URL` at that port, or MCP clients can't sign in.
[`.env.example`](./.env.example) describes each setting. Run each install's
`docker compose` commands from its own folder.

For each install:

- **Connect it as its own server** in your MCP client, under its own name and
  port. For Claude Code:
  `claude mcp add --scope user --transport http work http://localhost:8001/mcp`.
- **Update and restart it on its own:**
  - With the CLI: `npx vault-cortex@latest upgrade --dir ./vault-cortex-work`
    to update, or `npx vault-cortex@latest restart --dir ./vault-cortex-work`
    to restart.
  - With Compose: `docker compose pull && docker compose up -d` in its folder.
- **Use its name in `docker` commands.** The commands in this guide that name
  the container (`docker logs vault-cortex`, `docker restart vault-cortex`,
  `docker stop vault-cortex`) take the install's `INSTANCE_NAME` instead, for
  example `docker logs work`.

## Windows (Docker Desktop)

Vault Cortex runs in a Linux container, so on Windows it reaches your vault through
Docker Desktop's WSL2 bridge. Two things need a non-default code path across that
bridge: live re-indexing (the file watcher's native filesystem events don't cross it)
and the atomic hard-link write that `vault_move_note` and `vault_write_file` use to
create a file (hard links aren't supported there). **Setting `WINDOWS_MODE=true`
handles both** — the watcher switches to polling and that write becomes
rename-based — so a vault on a `C:\` drive works out of the box:

```bash
# in .env
VAULT_PATH=C:\Users\you\MyVault
WINDOWS_MODE=true
```

`WINDOWS_MODE` is safe to leave on for any Windows setup; reading, search, and other
writes work with or without it — it only changes how re-indexing and that write are
done.

**For best performance**, keep the vault inside the WSL2 filesystem (ext4) instead —
native filesystem events are lighter than polling, and you can leave `WINDOWS_MODE`
off:

```bash
# inside WSL (e.g. Ubuntu) — vault lives on ext4
mkdir -p ~/vaults/MyVault
# then in .env:  VAULT_PATH=/home/you/vaults/MyVault
```

You can still open and edit a WSL-hosted vault in Obsidian on Windows — it shows up in
File Explorer at `\\wsl$\Ubuntu\home\you\vaults\MyVault`.

## Memory

The memory layer is enabled by default. Set `MEMORY_ENABLED=false` in your
`.env` to disable it — memory tools are hidden, no files are created, and the
server runs without it.

When enabled, the server creates a memory folder (default: `About Me/`) with
starter template files on first startup, and agents grow it from there. See
[Memory](../../README.md#memory) in the main README for how the layer works,
and [templates/memory](../../templates/memory/README.md) for the file format.

## File Tools

File tools (`vault_read_file`, `vault_write_file`, `vault_delete_file`,
`vault_list_files`) are enabled by default. Set `FILE_TOOLS_ENABLED=false` in
your `.env` to hide them, or `DISABLED_TOOLS=vault_write_file,vault_delete_file`
to keep reading files but turn off writing and deleting them.

## Read-only mode

Set `READONLY_MODE=true` in your `.env` to hide every tool that edits,
creates, moves, or deletes notes or files. The memory folder is not auto-created.
Connected clients can read and search but never edit.

Need finer control? `DISABLED_TOOLS` hides exactly the tools you name,
comma-separated — e.g. `DISABLED_TOOLS=vault_delete_note,vault_move_note`
keeps writes on but removes deleting and moving notes. Names match the Tool
column in the [README tools table](https://github.com/aliasunder/vault-cortex#tools).
It only ever takes tools away: it can't bring back one that read-only mode
or another setting has already hidden.

## Deleting notes and files

Deletes honor the "Deleted files" setting in Obsidian (Settings → Files and
links), for notes and for other files alike:

- **"Move to system trash" (Obsidian's default)** — the container has no
  system trash, so a deleted note or file moves to the `.trash` folder inside
  your vault, the same fallback Obsidian itself uses when a system trash isn't
  available. The server cleans up what it put there after 30 days —
  set `TRASH_RETENTION_DAYS` in `.env` to change the window, or
  `TRASH_RETENTION_DAYS=none` to keep them forever. Only notes and files the
  server moved there are cleaned up; anything you or Obsidian put in `.trash`
  is never touched. Notes the server moved there with version 0.54.11 or
  earlier also stay. To reclaim space sooner, or to clear those older
  notes, empty the `.trash` folder yourself (it's hidden — press
  Cmd+Shift+. in Finder, or Ctrl+H in most Linux file managers, to show
  it).
- **"Move to Obsidian trash (.trash folder)"** — a deleted note or file
  moves to the same `.trash` folder and stays there until you empty it,
  exactly as in Obsidian.
- **"Permanently delete"** — the note or file is removed for good.

To restore a trashed note or file, move it out of `.trash` by hand.

## Daily notes

`vault_get_daily_note` finds your daily notes using the folder and date
format set in Obsidian's Daily notes options. The server reads them from
`.obsidian/daily-notes.json` in your vault folder, so there is nothing to set
up; changes you make in Obsidian apply on the next call.

The folder the server looks in depends on that file:

| In `daily-notes.json`                | Folder the server uses                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The file is missing or unreadable    | `Daily Notes`                                                                                                                                                                                        |
| **New file location** is empty       | The folder **Default location for new notes** names (Settings → Files and links, stored in `.obsidian/app.json`); the vault root for **Same folder as current file**, as in Obsidian for daily notes |
| **New file location** names a folder | That folder                                                                                                                                                                                          |

When daily notes land in the vault root, or in the **Default location for
new notes** folder because **New file location** is empty, the
`PROTECTED_PATHS` and `ORPHAN_EXCLUDE_FOLDERS` defaults leave them out:
delete and move work on them, and orphan results (`vault_find_orphans`) can
list them. Protecting or excluding that folder would also cover every other
note in it.

If you use the Periodic Notes plugin, whose settings `daily-notes.json`
doesn't hold, set `DAILY_NOTES_FOLDER` (any vault-relative path: `Journal`,
`Planner/Daily`, or `/` for the vault root), `DAILY_NOTES_FORMAT` (same
tokens as Obsidian's date format setting), or both, in `.env`. A set value
always wins over `daily-notes.json`; while that file is missing or
unreadable, an unset format is `YYYY-MM-DD`. Apply `.env` edits as the
**Changed `.env`?** note under [Restart](#restart) says.

A few date format tokens are unsupported: ordinals (`Do`, `Mo`, `DDDo`,
`wo`), `dd` (2-letter weekday), `d` (weekday number), `e` (locale weekday
number), `k`/`kk` (hour 1–24), `w` (week number), `Q` (quarter), `Z`/`ZZ`
(UTC offset), and the localized formats (`L`–`LLLL`, `LT`, `LTS`). If your format uses any of them,
`vault_get_daily_note` returns an error; change the format in Obsidian or set
`DAILY_NOTES_FORMAT` to a supported alternative.

## Configuration

Only `MCP_AUTH_TOKEN` and `VAULT_PATH` are required; `VAULT_PATH` must not
contain `*`, `?`, or `[`. The table lists every optional setting, and
[`.env.example`](./.env.example) documents each one.

| Setting                     | Default                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                | `http://localhost:8000`                       | The URL clients connect to, used for OAuth sign-in. When you change `PORT` or reach the server through another address, change it to match, or MCP clients can't sign in                                                                                                                                                                                                                        |
| `PORT`                      | `8000`                                        | Host port the server is published on                                                                                                                                                                                                                                                                                                                                                            |
| `BIND_ADDRESS`              | `127.0.0.1`                                   | Address on this computer the port is published on. `127.0.0.1` keeps the server reachable from this machine only; `0.0.0.0` lets other devices on your network reach it (see [Other computers on your network](#other-computers-on-your-network))                                                                                                                                               |
| `INSTANCE_NAME`             | `vault-cortex`                                | Names this install's container and search-index volume. Set it before the first start to run another vault on this machine (see [Run more than one vault](#run-more-than-one-vault)). Valid values: two or more lowercase letters, digits, hyphens or underscores, starting with a letter or digit                                                                                              |
| `TZ`                        | `UTC`                                         | Your IANA timezone (e.g. `America/New_York`) — affects daily note dates and timestamps                                                                                                                                                                                                                                                                                                          |
| `EMBEDDING_ENABLED`         | `true`                                        | Set `false` for keyword-only search: no model download (~59MB), no vector index, no hybrid search                                                                                                                                                                                                                                                                                               |
| `RERANK_MODE`               | `blended`                                     | `blended` reranks results with the cross-encoder (~200ms added latency); `none` skips reranking. Only takes effect when `EMBEDDING_ENABLED` is true                                                                                                                                                                                                                                             |
| `MEMORY_ENABLED`            | `true`                                        | Set `false` to hide the memory tools and skip creating the memory folder. `MEMORY_DIR` still supplies the defaults for `PROTECTED_PATHS` and `ORPHAN_EXCLUDE_FOLDERS`                                                                                                                                                                                                                           |
| `MEMORY_DIR`                | `About Me`                                    | Vault folder for structured memory files. A memory folder missing at startup is created with starter templates, so rename the existing folder in Obsidian before you change this                                                                                                                                                                                                                |
| `FILE_TOOLS_ENABLED`        | `true`                                        | Set `false` to hide the file tools; `DISABLED_TOOLS=vault_write_file,vault_delete_file` hides only writing and deleting                                                                                                                                                                                                                                                                         |
| `READONLY_MODE`             | `false`                                       | Set `true` to hide every tool that changes the vault and skip memory folder auto-creation — read and search only                                                                                                                                                                                                                                                                                |
| `DISABLED_TOOLS`            | none hidden                                   | Hide individual tools by name, comma-separated; names match the [README tools table](https://github.com/aliasunder/vault-cortex#tools). It cannot re-enable a tool another setting hides, and an unknown name stops the server at startup                                                                                                                                                       |
| `PROTECTED_PATHS`           | `MEMORY_DIR`, daily notes folder              | Comma-separated folders whose notes and files can't be deleted, whose notes can't be moved, and that no note can be moved into; their notes stay editable. The daily notes folder is read from `DAILY_NOTES_FOLDER` or `daily-notes.json` (see [Daily notes](#daily-notes) for root and empty settings). A value you set replaces both default folders, so list them too to keep them protected |
| `ORPHAN_EXCLUDE_FOLDERS`    | daily notes folder, `Templates`, `MEMORY_DIR` | Comma-separated folders whose notes never appear in orphan results (`vault_find_orphans`). A list you set replaces all defaults; `ORPHAN_EXCLUDE_FOLDERS=,` excludes nothing, and an empty value uses the defaults                                                                                                                                                                              |
| `DAILY_NOTES_FOLDER`        | from `daily-notes.json`                       | Sets the daily notes folder (see [Daily notes](#daily-notes)); `Daily Notes` when that file is missing or unreadable                                                                                                                                                                                                                                                                            |
| `DAILY_NOTES_FORMAT`        | from `daily-notes.json`                       | Sets the daily note filename format, with the same tokens as Obsidian's date format setting (see [Daily notes](#daily-notes)); `YYYY-MM-DD` when that file is missing or unreadable                                                                                                                                                                                                             |
| `TRASH_RETENTION_DAYS`      | `30`                                          | Days a note or file deleted under Obsidian's default "Move to system trash" setting stays in `.trash` before the server cleans it up; `none` keeps them forever. Only notes and files the server moved there are cleaned up (see [Deleting notes and files](#deleting-notes-and-files))                                                                                                         |
| `WINDOWS_MODE`              | `false`                                       | On Windows, set `true`: the file watcher switches to polling, and note moves and new files from `vault_write_file` to rename-based writes, so a vault on a `C:` drive works through Docker Desktop (see [Windows](#windows-docker-desktop))                                                                                                                                                     |
| `MAX_FILE_BYTES`            | `52428800` (50 MiB)                           | Largest file `vault_read_file` reads, in bytes; a larger file is refused, and a larger PDF is found in search by its name only                                                                                                                                                                                                                                                                  |
| `MAX_IMAGE_OUTPUT_BYTES`    | `49152` (48 KiB)                              | Byte budget for images `vault_read_file` returns, before base64 encoding; larger images are downscaled and recompressed to fit. Raise it for clients that accept larger responses                                                                                                                                                                                                               |
| `MAX_PDF_RENDER_PAGES`      | `5`                                           | Most PDF pages rendered as images when `raw: true` is set on `vault_read_file`; `MAX_IMAGE_OUTPUT_BYTES` is divided across them, so fewer pages means higher quality each                                                                                                                                                                                                                       |
| `SERVICE_DOCUMENTATION_URL` | the GitHub repo URL                           | URL returned in OAuth discovery metadata                                                                                                                                                                                                                                                                                                                                                        |
| `TRUST_PROXY_HOPS`          | `0`                                           | Set `1` when exactly one proxy you control sits in front of the server (Caddy, nginx, Cloudflare Tunnel) and nothing else can reach its port, so OAuth rate limiting and logs use the visitor's IP from `X-Forwarded-For`. With `0`, forwarding headers are ignored                                                                                                                             |
| `TRUST_FORWARDED_HOPS`      | `0`                                           | How many trailing `for=` entries in the [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239) `Forwarded` header belong to proxies you control. `0` ignores the header; `1` when the proxy in front writes it and is the only way to reach the server; `2` when a CDN fronts that proxy and is the only way to reach it                                                                            |
| `LOG_LEVEL`                 | `info`                                        | Logging verbosity: `debug`, `info`, `warn`, `error`                                                                                                                                                                                                                                                                                                                                             |
| `LOG_DIR`                   | `none`                                        | Directory inside the container for log files that survive container re-creation (e.g. `/data/logs`). The container's own log (what `docker logs` shows) is always written, but Docker discards it when the container is re-created                                                                                                                                                              |
| `LOG_RETENTION_DAYS`        | `90`                                          | Days to keep log files once `LOG_DIR` is a path; cleanup runs at startup and each day. Digits only; `0` keeps today, and invalid values warn and use `90`                                                                                                                                                                                                                                       |
| `LOG_MAX_DAILY_MB`          | `25`                                          | Maximum MB per daily log file: whole numbers of at least 1, or `none` for no cap. At the cap, file logging pauses until midnight in `TZ`; the container log continues                                                                                                                                                                                                                           |

## Troubleshooting

**"This sign-in can't continue" in the browser instead of the consent page.**
Your MCP client saved login details the server no longer has. Deleting the
server's data (`docker compose down -v`, or a fresh install under a new name)
resets the server's record of connected clients, so the client's saved login
no longer matches. The same happens when a sign-in was started more than an
hour ago and never approved. That page lists these steps too. Clear the
client's stored authorization for this server and reconnect so it registers
fresh:

- **Claude Code:** `claude mcp remove vault-cortex`, then
  `claude mcp add --scope user --transport http vault-cortex http://localhost:8000/mcp`
  (use your own name and port if you changed them).
- **mcp-remote without a `--header`:** delete the `.mcp-auth` folder in your
  home folder (`%USERPROFILE%\.mcp-auth` on Windows) and restart the client.
- **Other clients:** remove and re-add the server.

**"Invalid token" on the consent page even with the correct token.** The
consent form trims surrounding whitespace and line breaks from the token before
checking it, so a value copied out of a terminal (where a long token can wrap
across lines) still works. If you still see this error, double-check you copied
the full `MCP_AUTH_TOKEN` from your `.env` — a missing or extra character is the
usual cause.

**"container name vault-cortex already in use" on start or upgrade.** A
container from a different management method is still running. The CLI
(`npx vault-cortex@latest upgrade`) and Docker Compose (`docker compose up -d`)
manage the container independently — stop the existing one first with
`docker rm -f vault-cortex`, then retry with your preferred method. Setting
up a second vault? Give it its own name instead — see
[Run more than one vault](#run-more-than-one-vault).

**Another computer on your network can't connect.**

1. Check that you followed every step in
   [Other computers on your network](#other-computers-on-your-network),
   including step 4, which applies the edits.
2. On the other computer, open `http://<this computer's address>:8000/healthz`
   in a browser. `{"ok":true}` means it reaches the server, so go to step 4.
3. No answer? A firewall on this computer may block incoming connections.
   Allow Docker through it, then try step 2 again.
4. The page answers but sign-in fails? `PUBLIC_URL` in `.env` must match the
   address the client uses exactly, port included. Fix it, apply it as in
   step 4 of that section, and reconnect the client.

## Building from source

If you want to modify Vault Cortex and build from source, clone the repo and
use `docker-compose.local.yml` in the repo root instead. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the full development setup.
