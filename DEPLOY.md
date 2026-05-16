# Deployment (AWS — SST + Lightsail)

Full cloud deployment using SST v4 for infrastructure-as-code. Provisions a Lightsail VM, API Gateway with Lambda authorizer, and CI/CD via GitHub Actions.

For simpler setups, see [`deploy/local/`](./deploy/local/) (Docker on your machine) or [`deploy/remote/`](./deploy/remote/) (VPS + Obsidian Sync).

---

SST uses a stage name based on your OS username (run `npx sst secret list` once and SST writes `.sst/stage`). Commands below omit `--stage` to use the default.

## Prerequisites

- AWS credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker installed locally
- A GitHub PAT with `read:packages` + `write:packages` scopes
- A dedicated deploy SSH keypair at `~/.ssh/vault-cortex`. If you don't have one: `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`. SST uploads the public key to Lightsail. Both local dev and CI use the same key so deploys never trigger an instance replacement.

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

| Variable              | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_URL`          | API Gateway URL (from `sst deploy` output, available after first deploy) |
| `GHCR_USER`           | Your GitHub username                                                     |
| `GHCR_TOKEN`          | The GitHub PAT from prerequisites                                        |
| `VAULT_NAME`          | Your Obsidian vault name (exact, case-sensitive)                         |
| `VAULT_PASSWORD`      | Only if vault has E2E encryption                                         |
| `OBSIDIAN_AUTH_TOKEN` | Generate with the command below                                          |

The [`.env.example`](./.env.example) file also includes optional configuration for the memory system (`MEMORY_DIR`, `PROTECTED_PATHS`, `ORPHAN_EXCLUDE_FOLDERS`), timezone (`TZ`), and OAuth metadata (`SERVICE_DOCUMENTATION_URL`). All have sensible defaults — see the [Configuration](./README.md#configuration) section in the README.

```bash
docker run --rm -it --entrypoint get-token ghcr.io/belphemur/obsidian-headless-sync-docker:latest
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

On startup, docker-compose runs three services in order: `init-config-perms` (chowns the obsidian config volume — workaround for an upstream bug) → `obsidian-sync` (syncs your vault) → `vault-mcp` (MCP server). Both `obsidian-sync` and `vault-mcp` run as UID 1000 to share the `/vault` volume. See [ARCHITECTURE.md § Docker Compose Startup](./ARCHITECTURE.md#docker-compose-startup) for the full diagram.

## Verify

```bash
# Direct hit on the Lightsail VM (skips API Gateway):
curl http://<lightsailIp>:8000/healthz

# Full chain via API Gateway (validates the bearer token):
curl -H "Authorization: Bearer <McpAuthToken>" <apiUrl>/healthz
```

`<lightsailIp>` and `<apiUrl>` come from the `sst deploy` output (also in `.sst/outputs.json`).

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

GitHub Actions runs lint/test/build on every PR and push to main, and handles releases via tag push or manual dispatch. CI deploys land on the same Lightsail instance as your laptop deploys (the `SST_STAGE` repo variable pins the SST stage).

### Workflows

| Workflow             | Trigger                          | What it does                                                                                                                                                                                         |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | PR + push to main                | `prettier:check`, `lint`, `test`, `build`                                                                                                                                                            |
| `auto_release.yml`   | `v*` tag push (from your laptop) | Validates `package.json` version matches the tag → calls `deploy.yml` → creates a GitHub Release with auto-generated notes and updates `CHANGELOG.md`                                                |
| `manual_release.yml` | Actions UI (`workflow_dispatch`) | Bumps version, commits, tags, pushes, calls `deploy.yml`, creates the GitHub Release — all inline. Does NOT chain through `auto_release.yml` (a workflow-pushed tag can't trigger another workflow). |
| `deploy.yml`         | Reusable (`workflow_call`)       | OIDC AWS auth → `sst deploy` → Docker build/push to GHCR → SSH to Lightsail → `docker compose pull && up -d` → `/healthz` gate                                                                       |

> **Why two release paths?** Tag pushes done by `GITHUB_TOKEN` from inside a workflow can't trigger other workflows (GitHub's anti-loop guard). So `manual_release.yml` has to do its own deploy + release inline instead of relying on `auto_release.yml` firing. `auto_release.yml` still exists for the laptop path — when you push a tag from your terminal, your user account is the actor and the trigger fires normally.

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

| Variable                    | Purpose                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`       | IAM role ARN from the [OIDC setup](#github-oidc-setup-for-forkers) above. An identifier, not a credential — use a repo variable, not a secret.                                            |
| `AWS_REGION`                | AWS region for SST deployment (default: `us-east-1`). Must match the region in `sst.config.ts`.                                                                                           |
| `GHCR_USER`                 | GitHub username. Used in image tags and instance `.env`.                                                                                                                                  |
| `PUBLIC_URL`                | API Gateway URL (e.g. `https://<id>.execute-api.<region>.amazonaws.com`). Used for the healthcheck and written into the instance `.env` as the OAuth issuer URL.                          |
| `SST_STAGE`                 | SST stage name — see [SST stage](#sst-stage) above. Must match your local `.sst/stage` so CI and laptop deploys target the same infrastructure.                                           |
| `VAULT_NAME`                | Exact (case-sensitive) Obsidian vault name.                                                                                                                                               |
| `MEMORY_DIR`                | Optional. Memory folder name in the vault (default: `About Me`). See the [Configuration](./README.md#configuration) section.                                                              |
| `PROTECTED_PATHS`           | Optional. Comma-separated folders protected from deletion (default: `MEMORY_DIR, Daily Notes`). Overrides the default entirely when set.                                                  |
| `ORPHAN_EXCLUDE_FOLDERS`    | Optional. Comma-separated folders excluded from orphan detection (default: `Daily Notes, Templates, MEMORY_DIR`). Overrides the default entirely when set.                                |
| `SERVICE_DOCUMENTATION_URL` | Optional. URL in OAuth discovery metadata (default: `https://github.com/aliasunder/vault-cortex`). Set to your fork's URL.                                                                |
| `TZ`                        | Optional. Container timezone (default: `UTC`). Affects `vault_update_memory` date stamps and `vault_get_daily_note` date resolution. Set to your IANA timezone (e.g. `America/New_York`). |

**Secrets** (Settings → Secrets and variables → Actions → Secrets tab) — sensitive credentials:

| Secret                | Purpose                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHCR_TOKEN`          | Personal access token (classic) with `write:packages` + `read:packages`. Used by `docker login` both at build-push and on-instance pull. Persists across runs; rotate when stale. |
| `MCP_AUTH_TOKEN`      | Same value as the SST secret of the same name. Written into the instance `.env` for the Express auth layer.                                                                       |
| `OBSIDIAN_AUTH_TOKEN` | Output of `docker run --rm -it --entrypoint get-token ghcr.io/belphemur/obsidian-headless-sync-docker:latest`.                                                                    |
| `VAULT_PASSWORD`      | Optional — only set if your vault uses end-to-end encryption. Empty value is fine and ships through to `.env` as `VAULT_PASSWORD=`.                                               |
| `SSH_PUBKEY`          | Public key contents of your `~/.ssh/vault-cortex.pub` (literal, single line). Same key local dev and CI use — see [Prerequisites](#prerequisites).                                |
| `SSH_PRIVATE_KEY`     | Private half (`~/.ssh/vault-cortex`, full multi-line block including BEGIN/END markers). Loaded by `webfactory/ssh-agent` for SCP/SSH to the instance.                            |

Both halves come from the dedicated deploy keypair set up in [Prerequisites](#prerequisites). Generating a new keypair just for CI would cause SST to replace the Lightsail VM on the next deploy — that's why local and CI share the same key.

### Cutting a release

**Manual** — Actions tab → "Manual Release" → Run workflow → choose `patch`/`minor`/`major`. The job bumps `package.json`, commits, tags, and pushes. The tag push triggers `auto_release.yml` which deploys and creates the release.

**Tag push** — Bump `package.json` locally, commit on `main`, then `git tag v<version> && git push --tags`. Same auto-release flow runs.

### Rotating SSH keys

Changing the deploy keypair **triggers a VM replacement**. The `SSH_PUBKEY` GitHub secret flows through CI → `sst deploy` → `readSshPublicKey()` → Lightsail KeyPair `publicKey`. A changed public key replaces the KeyPair, which cascades to an Instance replacement. There's no way to rotate the SST-managed key without replacing the VM.

**Steps:**

1. Take a manual snapshot first (rollback point if the replacement goes wrong — see [RECOVERY.md](./RECOVERY.md) Scenario B): `aws lightsail create-instance-snapshot --instance-name vault-cortex-<stage> --instance-snapshot-name pre-key-rotation`
2. Regenerate the key: `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`
3. [Unprotect the instance](./RECOVERY.md#intentional-replace-bundle-upgrade-blueprint-change-etc) (required — `protect: true` blocks replacement)
4. Update both `SSH_PUBKEY` and `SSH_PRIVATE_KEY` GitHub secrets
5. Deploy — the VM is replaced with a fresh disk

**Data implications:** vault re-syncs from Obsidian, search index rebuilds automatically, but OAuth state (`oauth.db`) is lost — clients re-authenticate on next use.

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

`<lightsailIp>` comes from `sst deploy` output (also in `.sst/outputs.json`). Uses the dedicated deploy key (`~/.ssh/vault-cortex`). To also SSH with your personal key, add it post-provision: `ssh -i ~/.ssh/vault-cortex ubuntu@<IP> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub`.

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
docker logs vault-mcp 2>&1 | jq 'select(.clientIp == "73.48.22.1")'

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

## Troubleshooting

- **`npm run build` fails with `Property 'McpAuthToken' does not exist`** — `sst-env.d.ts` hasn't been generated. Run `npx sst deploy` (or `sst dev`) once for your stage.
- **`sst dev` errors with `SecretMissingError`** — set the three secrets first (one-time setup step 2).
- **`curl <lightsailIp>` hangs** — use `:8000`. The security group only allows ports 22 and 8000.
- **`scp` / `ssh` fails with `Permission denied (publickey)`** — your local SSH key doesn't match what SST deployed to the Lightsail KeyPair. Verify `~/.ssh/vault-cortex` exists (generate with `ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy -N ""`), then redeploy. To also use your personal key, add it post-provision: `ssh -i ~/.ssh/vault-cortex ubuntu@<IP> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub`.
- **`docker: command not found` on `lightsail:up`** — cloud-init hasn't finished installing Docker. The script waits up to 120s automatically; if it still times out, SSH in and check `tail /var/log/cloud-init-output.log`.
- **Host key changed warning** — the Lightsail instance was replaced (e.g. `userData` changed in `sst.config.ts`). The deploy key convention prevents key-change replacements, but other properties can still trigger it. Run `ssh-keygen -R <lightsailIp>` and retry.
