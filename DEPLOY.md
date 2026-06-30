# Deployment (AWS — SST + Lightsail)

Full cloud deployment using SST v4 for infrastructure-as-code. Provisions a Lightsail VM, API Gateway with Lambda authorizer, and CI/CD via GitHub Actions.

For simpler setups, see [`deploy/local/`](./deploy/local/) (Docker on your machine) or [`deploy/remote/`](./deploy/remote/) (VPS + [Obsidian Sync](https://obsidian.md/sync)).

---

SST uses a stage name based on your OS username (run `npx sst secret list` once and SST writes `.sst/stage`). Commands below omit `--stage` to use the default.

## Prerequisites

- AWS credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker installed locally
- A GitHub PAT with `read:packages` + `write:packages` scopes
- A dedicated deploy SSH keypair at `~/.ssh/vault-cortex`. If you don't have one: `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`. SST uploads the public key to Lightsail. Both local dev and CI use the same key so deploys never trigger an instance replacement.
- An [Obsidian](https://obsidian.md) vault (the data this server exposes)
- An [Obsidian Sync](https://obsidian.md/sync) subscription (the remote deploy uses obsidian-sync to mirror the vault between this VM and your Obsidian apps)

## One-time setup

**1. Install deps:**

```bash
npm install
```

**2. Generate MCP auth token and set SST secret:**

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
npx sst secret set McpAuthToken "$MCP_AUTH_TOKEN"
```

`McpAuthToken` is the only SST secret — it's linked to the Lambda authorizer. Obsidian credentials (`OBSIDIAN_AUTH_TOKEN`, `VAULT_NAME`) flow to Docker containers via the `.env` file, not through SST.

**3. Create the deploy `.env` file** (secrets live outside the repo at `~/.config/vault-cortex/.env`):

```bash
mkdir -p ~/.config/vault-cortex
cp .env.example ~/.config/vault-cortex/.env
chmod 600 ~/.config/vault-cortex/.env
```

Write the MCP token into `.env` (must match the SST secret from step 2):

```bash
sed -i '' "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN/" ~/.config/vault-cortex/.env
```

Then open `~/.config/vault-cortex/.env` and fill in the remaining values:

| Variable              | Value                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`          | API Gateway URL (from `sst deploy` output) — or your [custom domain](#custom-domain-optional) |
| `GHCR_USER`           | Your GitHub username                                                                          |
| `GHCR_TOKEN`          | The GitHub PAT from prerequisites                                                             |
| `VAULT_NAME`          | Your Obsidian vault name (exact, case-sensitive)                                              |
| `VAULT_PASSWORD`      | Only if vault has E2E encryption                                                              |
| `OBSIDIAN_AUTH_TOKEN` | Generate with the command below                                                               |

The [`.env.example`](./.env.example) file also includes optional configuration for the embedding pipeline (`EMBEDDING_ENABLED`), the reranker (`RERANK_MODE`), the memory system (`MEMORY_ENABLED`, `MEMORY_DIR`, `PROTECTED_PATHS`, `ORPHAN_EXCLUDE_FOLDERS`), timezone (`TZ`), and OAuth metadata (`SERVICE_DOCUMENTATION_URL`). All have sensible defaults — see the [Configuration](./README.md#configuration) section in the README.

```bash
docker run --rm -it --entrypoint get-token ghcr.io/aliasunder/obsidian-headless-sync-docker:latest
```

**4. Authenticate to GHCR** (once per machine):

```bash
echo "<your-GHCR_TOKEN>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

## Deploy

```bash
npm run deploy:dev
```

That runs, in order:

1. `npx sst deploy` — provisions Lightsail VM, API Gateway, smart Lambda authorizer
2. `npm run docker:publish` — builds (targeting linux/amd64) + pushes to GHCR
3. `npm run lightsail:up` — ensures `/opt/vault-cortex` exists, waits for Docker (cloud-init), logs into GHCR on the instance, SCPs `docker-compose.yml` + `.env`, then `docker compose pull && up -d`

On startup, docker-compose runs two services in order: `obsidian-sync` (syncs your vault) → `vault-mcp` (MCP server). Both run as UID 1000 to share the `/vault` volume. The obsidian config volume is owned `obsidian:obsidian` at image build time by the forked sync image, so no init container is needed. See [ARCHITECTURE.md § Docker Compose Startup](./ARCHITECTURE.md#docker-compose-startup) for the full diagram.

## Verify

```bash
# Full chain via API Gateway (validates the bearer token):
curl -H "Authorization: Bearer <McpAuthToken>" <apiUrl>/healthz

# Direct hit on the Lightsail VM (skips API Gateway).
# Skip if you've set MCP_PORT_CIDRS=none (port 8000 closed).
curl http://<lightsailIp>:8000/healthz

# If using ORIGIN_URL (tunnel/proxy), verify it reaches vault-mcp:
curl <ORIGIN_URL>/healthz
```

`<apiUrl>` comes from the `sst deploy` output (also in `.sst/outputs.json`). The Lightsail IP is deliberately **not** an SST output — outputs print on every deploy, and on a public repo that means public Actions logs. Fetch it from AWS instead:

```bash
aws lightsail get-static-ip --static-ip-name vault-cortex-ip-<stage> \
  --query staticIp.ipAddress --output text
```

## Command reference

| Command                  | What it does                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run deploy`         | `npx sst deploy` — creates/updates AWS infra. First run provisions everything; subsequent runs are incremental. |
| `npm run docker:publish` | Builds the vault-mcp image (linux/amd64) and pushes to GHCR.                                                    |
| `npm run lightsail:up`   | Bootstraps the VM (mkdir, Docker wait, GHCR login), SCPs config, pulls + restarts containers. Volumes persist.  |
| `npm run deploy:dev`     | Full chain: `deploy` → `docker:publish` → `lightsail:up`.                                                       |
| `npx sst remove`         | **Destructive** — deletes Lightsail VM, API Gateway, Lambda. Frees the ~$12/mo.                                 |

All commands are idempotent and safe to run repeatedly.

## Updating the deployed app

App-only update (no infra changes):

```bash
npm run docker:publish && npm run lightsail:up
```

Infra changes (anything in `sst.config.ts`): use `npm run deploy:dev` (full chain) or `npx sst deploy` (infra only).

## Tearing down

```bash
npx sst remove   # removes Lightsail, API Gateway, Lambda
```

---

## CI/CD

GitHub Actions runs lint/test/build plus security scans (secret detection, image vulnerabilities) on every PR and push to main, and handles releases via tag push or manual dispatch. CI deploys land on the same Lightsail instance as your laptop deploys (the `SST_STAGE` repo variable pins the SST stage).

### Workflows

| Workflow               | Trigger                          | What it does                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`               | PR + push to main                | `prettier:check`, `lint`, `test`, `build`                                                                                                                                                                                                                      |
| `gitleaks.yml`         | PR + push to main                | Secret detection across the repo and its git history                                                                                                                                                                                                           |
| `trivy.yml`            | PR + push to main + weekly cron  | Vulnerability scan of the Docker image — PRs scan an image built from the branch (`trivy-pr` gates merges on fixable CRITICAL/HIGH findings); pushes and the cron scan the published GHCR `:latest` report-only. Findings upload as SARIF to the Security tab. |
| `scorecard.yml`        | Push to main + weekly cron       | [OpenSSF Scorecard](https://github.com/ossf/scorecard) supply-chain posture analysis; results upload to the Security tab. Also re-runs when branch protection settings change.                                                                                 |
| `auto_release.yml`     | `v*` tag push (from your laptop) | Validates `package.json` version matches the tag → calls `deploy.yml` + `publish-registry.yml` → creates a GitHub Release with auto-generated notes and updates `CHANGELOG.md`                                                                                 |
| `manual_release.yml`   | Actions UI (`workflow_dispatch`) | Bumps version, commits, tags, pushes, calls `deploy.yml` + `publish-registry.yml`, creates the GitHub Release — all inline. Does NOT chain through `auto_release.yml` (a workflow-pushed tag can't trigger another workflow).                                  |
| `deploy.yml`           | Reusable (`workflow_call`)       | OIDC AWS auth → `sst deploy` → Docker build/push to GHCR → SSH to Lightsail → `docker compose pull && up -d` → `/healthz` gate                                                                                                                                 |
| `publish-registry.yml` | Reusable (`workflow_call`)       | Publishes `server.json` to the [official MCP Registry](https://registry.modelcontextprotocol.io/) via `mcp-publisher`, authenticating with GitHub OIDC. Runs after `deploy` (so the GHCR image referenced in `server.json` already exists).                    |
| `cli_release.yml`      | Actions UI (`workflow_dispatch`) | Publishes the `cli/` package to npm via Trusted Publishing — independent of server releases. See [CONTRIBUTING.md](./CONTRIBUTING.md#the-cli-package).                                                                                                         |

> **Why two release paths?** Tag pushes done by `GITHUB_TOKEN` from inside a workflow can't trigger other workflows (GitHub's anti-loop guard). So `manual_release.yml` has to do its own deploy + release inline instead of relying on `auto_release.yml` firing. `auto_release.yml` still exists for the laptop path — when you push a tag from your terminal, your user account is the actor and the trigger fires normally.

> **MCP Registry publishing is automatic.** Both release paths call `publish-registry.yml`, so the [official MCP Registry](https://registry.modelcontextprotocol.io/) entry tracks every release — no manual `mcp-publisher publish`. It authenticates with [GitHub OIDC](https://modelcontextprotocol.io/registry/github-actions) and needs **no secret**: the registry authorizes the `io.github.<owner>/*` namespace from the OIDC token's repo owner, so a fork publishing `io.github.<your-user>/...` works out of the box (unlike the AWS OIDC role below, which you must provision).

### GitHub OIDC setup (for forkers)

The deploy workflow uses [GitHub OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) to assume an AWS IAM role without long-lived credentials. If you're forking this project, you need to create your own OIDC provider and IAM role in your AWS account.

**1. Create the OIDC identity provider** in IAM (one-time, per AWS account):

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

See [AWS docs: Creating an OIDC provider](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).

**2. Create an IAM role** with this trust policy (replace the repo reference with your fork):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_FORK:*"
        }
      }
    }
  ]
}
```

**3. Attach permissions.** SST recommends `AdministratorAccess` for simplicity. For a scoped-down policy, see [SST's IAM credentials guide](https://sst.dev/docs/iam-credentials).

**4. Set the role ARN** as the `AWS_DEPLOY_ROLE_ARN` variable in your fork's GitHub Actions settings.

### SST stage

SST creates a stage on your first `sst deploy` — the default is your OS username, stored in `.sst/stage`. For CI, the `SST_STAGE` variable must match this value so CI deploys land on the same Lightsail instance and SST state as your laptop deploys.

To find your stage: `cat .sst/stage` (after your first deploy).

### Required repo configuration

**Variables** (Settings → Secrets and variables → Actions → Variables tab) — non-sensitive identifiers and config:

| Variable                    | Purpose                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`       | IAM role ARN from the [OIDC setup](#github-oidc-setup-for-forkers) above. An identifier, not a credential — use a repo variable, not a secret.                                                                    |
| `AWS_REGION`                | AWS region for SST deployment (default: `us-east-1`). Must match the region in `sst.config.ts`.                                                                                                                   |
| `GHCR_USER`                 | GitHub username. Used in image tags and instance `.env`.                                                                                                                                                          |
| `PUBLIC_URL`                | API Gateway URL (e.g. `https://<id>.execute-api.<region>.amazonaws.com`) or your [custom domain](#custom-domain-optional). Used for the healthcheck and written into the instance `.env` as the OAuth issuer URL. |
| `SST_STAGE`                 | SST stage name — see [SST stage](#sst-stage) above. Must match your local `.sst/stage` so CI and laptop deploys target the same infrastructure.                                                                   |
| `VAULT_NAME`                | Exact (case-sensitive) Obsidian vault name.                                                                                                                                                                       |
| `EMBEDDING_ENABLED`         | Optional. Set `false` to disable the embedding pipeline — skips model download, vector tables, embedding passes, and hybrid search. Search falls back to FTS5 keyword matching. Default: `true`.                  |
| `RERANK_MODE`               | Optional. Cross-encoder reranking mode: `blended` (default) applies position-aware score blending after RRF fusion, `none` skips reranking for lower latency. Only takes effect when `EMBEDDING_ENABLED` is true. |
| `MEMORY_ENABLED`            | Optional. Set `false` to disable the memory layer entirely — hides memory tools, skips bootstrap, omits memory from server metadata. Default: `true`.                                                             |
| `MEMORY_DIR`                | Optional. Memory folder name in the vault (default: `About Me`). Ignored when `MEMORY_ENABLED` is `false`. See the [Configuration](./README.md#configuration) section.                                            |
| `PROTECTED_PATHS`           | Optional. Comma-separated folders protected from deletion (default: `MEMORY_DIR, Daily Notes`). Overrides the default entirely when set.                                                                          |
| `ORPHAN_EXCLUDE_FOLDERS`    | Optional. Comma-separated folders excluded from orphan detection (default: `Daily Notes, Templates, MEMORY_DIR`). Overrides the default entirely when set.                                                        |
| `SERVICE_DOCUMENTATION_URL` | Optional. URL in OAuth discovery metadata (default: `https://github.com/aliasunder/vault-cortex`). Set to your fork's URL.                                                                                        |
| `TZ`                        | Optional. Container timezone (default: `UTC`). Affects `vault_update_memory` date stamps and `vault_get_daily_note` date resolution. Set to your IANA timezone (e.g. `America/New_York`).                         |

**Secrets** (Settings → Secrets and variables → Actions → Secrets tab) — sensitive credentials:

| Secret                   | Purpose                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHCR_TOKEN`             | Personal access token (classic) with `write:packages` + `read:packages`. Used by `docker login` both at build-push and on-instance pull. Persists across runs; rotate when stale. |
| `MCP_AUTH_TOKEN`         | Same value as the SST secret of the same name. Written into the instance `.env` for the Express auth layer.                                                                       |
| `OBSIDIAN_AUTH_TOKEN`    | Output of `docker run --rm -it --entrypoint get-token ghcr.io/aliasunder/obsidian-headless-sync-docker:latest`.                                                                   |
| `VAULT_PASSWORD`         | Optional — only set if your vault uses end-to-end encryption. Empty value is fine and ships through to `.env` as `VAULT_PASSWORD=`.                                               |
| `SSH_PUBKEY`             | Public key contents of your `~/.ssh/vault-cortex.pub` (literal, single line). Same key local dev and CI use — see [Prerequisites](#prerequisites).                                |
| `SSH_PRIVATE_KEY`        | Private half (`~/.ssh/vault-cortex`, full multi-line block including BEGIN/END markers). Loaded by `webfactory/ssh-agent` for SCP/SSH to the instance.                            |
| `CUSTOM_DOMAIN`          | Optional. Custom domain for API Gateway (e.g. `mcp.example.com`) — see [Custom Domain](#custom-domain-optional). Set together with `CUSTOM_DOMAIN_CERT_ARN`.                      |
| `CUSTOM_DOMAIN_CERT_ARN` | Optional. ARN of an **Issued** ACM certificate (same region as the API) covering `CUSTOM_DOMAIN`.                                                                                 |

Both halves come from the dedicated deploy keypair set up in [Prerequisites](#prerequisites). Generating a new keypair just for CI would cause SST to replace the Lightsail VM on the next deploy — that's why local and CI share the same key.

### Cutting a release

**Manual** — Actions tab → "Manual Release" → Run workflow → choose `patch`/`minor`/`major`. The job bumps `package.json`, commits, tags, deploys, and creates the GitHub Release — all inline (a workflow-pushed tag can't trigger `auto_release.yml`; see [Workflows](#workflows)).

**Tag push** — merge a version-bump PR into `main`, then tag the merge commit: `git tag v<version> && git push --tags`. The tag push triggers `auto_release.yml`, which deploys and creates the release.

Direct commits to `main` are blocked by a branch ruleset — every change, version bumps included, lands via PR. Release automation is the only actor that pushes to `main` directly (the changelog and version-bump commits in the workflows above).

### Rotating SSH keys

Changing the deploy keypair **triggers a VM replacement**. The `SSH_PUBKEY` GitHub secret flows through CI → `sst deploy` → `readSshPublicKey()` → Lightsail KeyPair `publicKey`. A changed public key replaces the KeyPair, which cascades to an Instance replacement. There's no way to rotate the SST-managed key without replacing the VM.

**Steps:**

1. Take a manual snapshot first (rollback point if the replacement goes wrong — see [RECOVERY.md](./RECOVERY.md) Scenario B): `aws lightsail create-instance-snapshot --instance-name vault-cortex-<stage> --instance-snapshot-name pre-key-rotation`
2. Regenerate the key: `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`
3. [Unprotect the instance](./RECOVERY.md#intentional-replace-bundle-upgrade-blueprint-change-etc) (required — `protect: true` blocks replacement)
4. Update both `SSH_PUBKEY` and `SSH_PRIVATE_KEY` GitHub secrets
5. Deploy — the VM is replaced with a fresh disk

**Data implications:** vault re-syncs from Obsidian and the search index rebuilds automatically, so the MCP server recovers quickly. What you lose: OAuth state (`oauth.db` — clients re-authenticate on next use), accumulated Docker logs, and anything manually installed on the VM outside of IaC (ad-hoc `apt install`, Tailscale, cron jobs, etc.).

**Tailscale note:** If using `SSH_CIDRS=none` (Tailscale-only SSH), the new VM won't have Tailscale. Temporarily set `SSH_CIDRS=0.0.0.0/0` for the replacement deploy, SSH in to reinstall Tailscale, then set `SSH_CIDRS=none` and redeploy. See [SSH Hardening with Tailscale](#ssh-hardening-with-tailscale-optional).

**Adding a personal SSH key (no rotation):** To SSH with an additional key without touching SST, add it to `authorized_keys` directly:

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<lightsailIp> \
  "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub
```

### Rotating `MCP_AUTH_TOKEN`

The token must stay in sync across three places: the SST secret (`sst secret set McpAuthToken`), the GitHub repo secret, and the instance `.env`. CI writes the instance `.env` from the GitHub secret on every deploy, so the laptop rotation procedure becomes:

```bash
NEW_TOKEN=$(openssl rand -hex 32)
npx sst secret set McpAuthToken "$NEW_TOKEN"
gh secret set MCP_AUTH_TOKEN --body "$NEW_TOKEN"
# Then dispatch manual_release.yml or push a new tag — CI takes care of the rest.
```

### Don't fork-deploy without re-staging

Forks don't inherit GitHub Actions variables or secrets, and the OIDC role is scoped to both a specific AWS account and repo. Before using the deploy or release workflows, provision your own AWS infrastructure and configure your fork's variables — see [GitHub OIDC setup](#github-oidc-setup-for-forkers) and [Required repo configuration](#required-repo-configuration) above.

---

## Monitoring

### SSH into the server

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<lightsailIp>
```

`<lightsailIp>` comes from `aws lightsail get-static-ip` (see [Verify](#verify) — it is deliberately not an SST output). Uses the dedicated deploy key (`~/.ssh/vault-cortex`). To also SSH with your personal key, add it post-provision: `ssh -i ~/.ssh/vault-cortex ubuntu@<IP> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub`.

### Tailing logs

Both containers write structured JSON to stdout/stderr, captured by Docker's `json-file` log driver (10MB per file, 3 rotated files — ~30MB retained per container).

```bash
# Follow vault-mcp logs in real time
docker logs -f vault-mcp

# With timestamps
docker logs -f --timestamps vault-mcp

# Last 50 lines + follow
docker logs -f --tail 50 vault-mcp

# obsidian-sync logs (for cross-referencing file sync activity)
docker logs -f obsidian-sync
```

### Filtering with jq

vault-mcp logs are structured JSON with `timestamp`, `level`, `message`, `source` (file:line), plus contextual properties like `requestId`, `sessionId`, `tool`, `clientIp`.

```bash
# Errors only (token mismatch, watcher failures — things that need fixing)
docker logs vault-mcp 2>&1 | jq 'select(.level == "error")'

# Trace a single request across all layers
docker logs vault-mcp 2>&1 | jq 'select(.requestId == "1")'

# All activity from a specific client IP
docker logs vault-mcp 2>&1 | jq 'select(.clientIp == "203.0.113.42")'

# All tool calls
docker logs vault-mcp 2>&1 | jq 'select(.message == "tool_call")'

# Auth failures
docker logs vault-mcp 2>&1 | jq 'select(.message | startswith("auth_failed"))'
```

Note: `2>&1` is needed because error-level logs go to stderr — piping to jq requires combining both streams.

### Log levels

| Level   | Meaning                           | Examples                                                  |
| ------- | --------------------------------- | --------------------------------------------------------- |
| `error` | Something is broken — investigate | Token mismatch, file watcher failure, unhandled exception |
| `warn`  | Unexpected but not broken         | Malformed auth header, stale session ID, tool input error |
| `info`  | Normal operations                 | Tool calls, reads, writes, searches, session lifecycle    |
| `debug` | Verbose tracing (dev only)        | File watcher indexing individual files                    |

Set `LOG_LEVEL` in `.env` to control the threshold (default: `info`).

---

## SSH Hardening with Tailscale (Optional)

By default, SSH (port 22) is open to all IPs on the Lightsail firewall. For production or public-facing deployments, restrict SSH to your Tailscale network.

### How it works

Tailscale creates a WireGuard mesh network between your devices. Traffic between Tailscale nodes flows through the `tailscale0` interface, which **bypasses** the Lightsail public-IP firewall entirely. By removing port 22 from the firewall, public SSH is blocked while SSH via the Tailscale IP continues to work.

### Setup

**Prerequisites:** Tailscale installed on your laptop/phone (client) and the Lightsail VM (server).

**1. Install Tailscale on the Lightsail VM** (one-time, via SSH):

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<lightsailIp>
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<YOUR_AUTH_KEY> --hostname=vault-cortex --advertise-tags=tag:server --reset
```

Use a **reusable, non-expiring** auth key from https://login.tailscale.com/admin/settings/keys with tag `tag:server`. The `--reset` flag clears any prior registration state. Do NOT use `--ssh` (that replaces OpenSSH with Tailscale SSH — we want standard SSH over the Tailscale network).

**2. Verify Tailscale SSH** from your laptop:

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@vault-cortex
```

This connects via MagicDNS. You can also use the Tailscale IP directly (`100.x.y.z` from `tailscale status`).

**3. Close public SSH** — set `SSH_CIDRS=none` and deploy:

```bash
SSH_CIDRS=none npx sst deploy
```

This removes port 22 from the Lightsail firewall. SSH via the public IP is now blocked; SSH via Tailscale continues to work.

**4. Update local dev** — add to `~/.config/vault-cortex/.env`:

```
LIGHTSAIL_SSH_HOST=vault-cortex
```

Now `npm run lightsail:up` connects via Tailscale instead of the public IP.

### CI/CD with Tailscale

The deploy workflow supports optional Tailscale connectivity for SSH steps. Gated by the presence of `TAILSCALE_SSH_HOST` — if not set, CI uses the public IP (default behavior).

**GitHub repo settings:**

| Type     | Name                            | Value                                               |
| -------- | ------------------------------- | --------------------------------------------------- |
| Variable | `TAILSCALE_SSH_HOST`            | `vault-cortex` (MagicDNS) or the Tailscale IP       |
| Variable | `SSH_CIDRS`                     | `none` (removes port 22 from public firewall)       |
| Secret   | `TAILSCALE_OAUTH_CLIENT_ID`     | From Tailscale admin → Settings → Trust Credentials |
| Secret   | `TAILSCALE_OAUTH_CLIENT_SECRET` | (same)                                              |

**Tailscale admin setup:**

1. Create an OAuth client at Tailscale admin → Settings → Trust Credentials → +Credential → OAuth → Continue — scopes: Devices Core (Read + Write) + Auth Keys (Write), tag: `tag:ci`
2. Add tag owners and ACL grants in https://login.tailscale.com/admin/acls:
   ```json
   {
     "tagOwners": {
       "tag:server": ["autogroup:owner"],
       "tag:ci": ["autogroup:owner"]
     },
     "grants": [
       { "src": ["autogroup:owner"], "dst": ["*"], "ip": ["*"] },
       { "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["22"] }
     ]
   }
   ```

CI nodes are ephemeral (auto-removed after inactivity) thanks to the OAuth client auth method.

### SSH_CIDRS reference

`SSH_CIDRS` accepts any of these values:

| Value                          | Effect                                               |
| ------------------------------ | ---------------------------------------------------- |
| (unset)                        | `0.0.0.0/0` — open to all (default, backward-compat) |
| `none`                         | Port 22 set to non-routable CIDR (Tailscale-only)    |
| `100.64.0.0/10`                | Tailscale CIDR only (belt-and-suspenders)            |
| `203.0.113.42/32`              | Single IP (e.g., home IP)                            |
| `100.64.0.0/10,203.0.113.0/24` | Multiple CIDRs (comma-separated)                     |

### Fresh VM bootstrap (chicken-and-egg)

If the VM is replaced (key rotation, bundle upgrade) and `SSH_CIDRS=none`, port 22 is closed on the public IP — but Tailscale isn't yet running on the new VM. Recovery:

1. Temporarily set `SSH_CIDRS=0.0.0.0/0` (or remove the variable)
2. Deploy — port 22 re-opens
3. SSH in, install Tailscale, authenticate with the reusable auth key
4. Set `SSH_CIDRS=none` and redeploy

### Rollback

To revert to public SSH at any time:

```bash
# Re-open port 22 via SST (no SSH needed — runs from your laptop)
SSH_CIDRS=0.0.0.0/0 npx sst deploy
```

Or via AWS CLI for immediate effect (overwritten on next SST deploy):

```bash
aws lightsail put-instance-public-ports \
  --instance-name vault-cortex-<stage> \
  --port-infos '[{"protocol":"tcp","fromPort":22,"toPort":22,"cidrs":["0.0.0.0/0"]},{"protocol":"tcp","fromPort":8000,"toPort":8000,"cidrs":["0.0.0.0/0"]}]'
```

---

## Port 8000 Hardening (Optional)

By default, port 8000 is open to all IPs on the Lightsail firewall. API Gateway provides TLS for MCP client traffic, but port 8000 itself is plain HTTP — anyone who discovers the Lightsail IP (via scanning, Shodan, or historical records) can reach it directly. With `ORIGIN_URL` and `MCP_PORT_CIDRS`, you can route API Gateway through a tunnel or reverse proxy and close port 8000 entirely.

### How it works

`ORIGIN_URL` tells API Gateway where to route MCP traffic. When set, API Gateway sends requests to this URL instead of `http://<lightsail-ip>:8000`. The URL can be a Cloudflare Tunnel, Caddy reverse proxy, Tailscale Funnel, or any HTTPS frontend that proxies to `localhost:8000` on the Lightsail instance.

`MCP_PORT_CIDRS` controls port 8000 on the Lightsail firewall — same format as `SSH_CIDRS`. Set to `none` to block all direct access (traffic flows through the tunnel/proxy instead).

Together: `ORIGIN_URL` provides the alternative path, `MCP_PORT_CIDRS=none` closes the direct path.

### Example: Cloudflare Tunnel

Cloudflare Tunnel (`cloudflared`) establishes an outbound-only connection from the Lightsail host to Cloudflare's edge. No inbound ports required — port 8000 is removed from the firewall entirely. The tunnel hostname serves as the HTTPS endpoint.

**Prerequisites:** A free [Cloudflare account](https://dash.cloudflare.com/sign-up) with at least one domain using Cloudflare's nameservers. The tunnel routes through a subdomain on that domain (e.g., `tunnel.yourdomain.dev`).

**1. Create a tunnel** in the Cloudflare dashboard:

Go to [Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels → Create a tunnel → Cloudflared → name it (e.g., `vault-cortex`). Cloudflare generates a tunnel token.

**2. Install `cloudflared` on the Lightsail VM** (one-time, via SSH):

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update && sudo apt-get install -y cloudflared
sudo cloudflared service install <TUNNEL_TOKEN>
```

After install, `cloudflared` runs as a systemd service, survives reboots, and is invisible to the Docker stack.

**3. Configure the tunnel route** in the Cloudflare dashboard:

In the tunnel's Public Hostname tab, add a route:

- Subdomain: your chosen subdomain (e.g., `tunnel`)
- Domain: select your Cloudflare-managed domain
- Service: `http://localhost:8000`

**4. Verify the tunnel** before closing port 8000:

```bash
curl https://<subdomain>.<yourdomain>/healthz
# Should return 200 OK
```

**5. Close port 8000** — set `ORIGIN_URL` and `MCP_PORT_CIDRS=none`, then deploy:

```bash
ORIGIN_URL=https://<subdomain>.<yourdomain> MCP_PORT_CIDRS=none npx sst deploy
```

**6. Verify port 8000 is closed:**

```bash
# Direct access — should timeout (port closed on firewall)
curl --connect-timeout 5 http://<lightsailIp>:8000/healthz

# API Gateway — should return 200 (routed through tunnel)
curl https://<api-gateway-url>/healthz
```

### MCP_PORT_CIDRS reference

`MCP_PORT_CIDRS` accepts any of these values:

| Value             | Effect                                                     |
| ----------------- | ---------------------------------------------------------- |
| (unset)           | `0.0.0.0/0` — open to all (default, backward-compat)       |
| `none`            | Port 8000 set to non-routable CIDR (use with `ORIGIN_URL`) |
| `<your-ip>/32`    | Single IP (e.g., your home IP)                             |
| `<cidr1>,<cidr2>` | Multiple CIDRs (comma-separated)                           |

### Fresh VM bootstrap

If the VM is replaced (bundle upgrade for Phase 2, key rotation) and `MCP_PORT_CIDRS=none`, port 8000 is closed — but `cloudflared` isn't running on the new VM yet. Recovery:

1. Temporarily open both ports and disable tunnel routing:
   ```bash
   SSH_CIDRS=0.0.0.0/0 ORIGIN_URL= MCP_PORT_CIDRS=0.0.0.0/0 npx sst deploy
   ```
2. SSH in via public IP, install Tailscale (see [SSH Hardening](#ssh-hardening-with-tailscale-optional))
3. Install `cloudflared` and register with the existing tunnel token:
   ```bash
   sudo apt-get update && sudo apt-get install -y cloudflared
   sudo cloudflared service install <TUNNEL_TOKEN>
   ```
4. Verify the tunnel: `curl https://<subdomain>.<yourdomain>/healthz`
5. Re-harden:
   ```bash
   SSH_CIDRS=none ORIGIN_URL=https://<subdomain>.<yourdomain> MCP_PORT_CIDRS=none npx sst deploy
   ```

The tunnel token doesn't change when the VM is replaced — it's tied to the Cloudflare tunnel resource, not the host.

### Rollback

To revert to direct port 8000 access at any time:

```bash
# Remove ORIGIN_URL and re-open port 8000 (no SSH needed — runs from your laptop)
ORIGIN_URL= MCP_PORT_CIDRS=0.0.0.0/0 npx sst deploy
```

Or via AWS CLI for immediate firewall change (overwritten on next SST deploy):

```bash
aws lightsail put-instance-public-ports \
  --instance-name vault-cortex-<stage> \
  --port-infos '[{"protocol":"tcp","fromPort":22,"toPort":22,"cidrs":["0.0.0.0/0"]},{"protocol":"tcp","fromPort":8000,"toPort":8000,"cidrs":["0.0.0.0/0"]}]'
```

---

## Custom Domain (Optional)

By default, clients reach the server at the auto-generated API Gateway URL (`https://<id>.execute-api.<region>.amazonaws.com`). A custom domain (e.g. `mcp.example.com`) replaces that with your own hostname — nicer connect URLs, and MCP clients that derive a connector icon from the URL's domain show your site's favicon instead of the AWS one.

DNS stays with your provider (Cloudflare, Route 53, anything) — SST only creates the API Gateway domain and stage mapping from a certificate you already hold. The default execute-api URL keeps working alongside the custom domain, so existing OAuth clients are not cut off.

**1. Get an ACM certificate** in the same region as the API, covering the domain (exact name or a wildcard like `*.example.com`). Request it in the ACM console (or any IaC), add the DNS validation record at your DNS provider, and wait for status **Issued**. The cert is referenced by ARN — it can live in your account already.

**2. Deploy with the domain configured:**

```bash
CUSTOM_DOMAIN=mcp.example.com \
CUSTOM_DOMAIN_CERT_ARN=arn:aws:acm:us-east-1:<account>:certificate/<id> \
npx sst deploy
```

For CI deploys, set both as repo secrets — `deploy.yml` passes them through. Both must be set together; `CUSTOM_DOMAIN` without the cert ARN fails fast with an error.

**3. Point DNS at the gateway** — fetch the gateway's target hostname (a `d-xxxx.execute-api.<region>.amazonaws.com` name; deliberately not a deploy output, so it stays out of public CI logs):

```bash
aws apigatewayv2 get-domain-name --domain-name mcp.example.com \
  --query 'DomainNameConfigurations[0].ApiGatewayDomainName' --output text
```

Create a CNAME from your domain to that target at your DNS provider. Verify:

```bash
curl https://mcp.example.com/healthz
# → {"ok":true}
```

**4. Update `PUBLIC_URL`** to `https://mcp.example.com` (instance `.env` + the repo secret for CI) and redeploy or restart, so OAuth discovery metadata advertises the custom domain. Existing OAuth clients connected via the execute-api URL keep working; new connections should use the custom domain.

---

## Troubleshooting

- **`npm run build` fails with `Property 'McpAuthToken' does not exist`** — `sst-env.d.ts` hasn't been generated. Run `npx sst deploy` (or `sst dev`) once for your stage.
- **`sst dev` errors with `SecretMissingError`** — set the secret first (one-time setup step 2).
- **`curl <lightsailIp>` hangs** — use `:8000`. The firewall only allows ports 22 and 8000 by default (port 22 may be closed if `SSH_CIDRS=none`, port 8000 may be closed if `MCP_PORT_CIDRS=none`).
- **`scp` / `ssh` fails with `Permission denied (publickey)`** — your local SSH key doesn't match what SST deployed to the Lightsail KeyPair. Verify `~/.ssh/vault-cortex` exists (generate with `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`), then redeploy. To also use your personal key, add it post-provision: `ssh -i ~/.ssh/vault-cortex ubuntu@<IP> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub`.
- **`docker: command not found` on `lightsail:up`** — cloud-init hasn't finished installing Docker. The script waits up to 120s automatically; if it still times out, SSH in and check `tail /var/log/cloud-init-output.log`.
- **Host key changed warning** — the Lightsail instance was replaced (e.g. `userData` changed in `sst.config.ts`). The deploy key convention prevents key-change replacements, but other properties can still trigger it. Run `ssh-keygen -R <lightsailIp>` and retry.
