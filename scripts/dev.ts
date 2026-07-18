#!/usr/bin/env tsx
/**
 * Deployment helper.
 *
 * Subcommands:
 *   docker:build    Build the vault-cortex image locally
 *   docker:push     Push to GHCR
 *   docker:publish  Build + push
 *   lightsail:up    SCP docker-compose.yml + ~/.config/vault-cortex/.env
 *                   to the VM, then `docker compose pull && up -d` over SSH
 *
 * The image is always `ghcr.io/${GHCR_USER}/vault-cortex:remote` — the
 * Dockerfile's remote target, because this script's purpose is the
 * Lightsail deployment and that's the tag its compose file pulls. The
 * Lightsail IP is fetched from AWS (`aws lightsail get-static-ip`)
 * using the stage in `.sst/stage` — it's deliberately not an SST
 * output, so deploys never print it (CI logs are public).
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ENV_PATH = join(homedir(), ".config", "vault-cortex", ".env")

const loadDotEnv = (): Record<string, string> => {
  if (!existsSync(ENV_PATH)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/i.exec(line.trim())
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined)
      out[key] = value.replace(/^['"]|['"]$/g, "")
  }
  return out
}

const expandHome = (path: string): string =>
  path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path

const env: NodeJS.ProcessEnv = { ...loadDotEnv(), ...process.env }

/** In GitHub Actions, masks a value so it appears as *** in logs. No-op locally. */
const mask = (value: string): void => {
  if (env.CI) console.log(`::add-mask::${value}`)
}

const ghcrUser = env.GHCR_USER
if (!ghcrUser) {
  console.error("✕  GHCR_USER not set. Set it in ~/.config/vault-cortex/.env")
  process.exit(1)
}
const image = `ghcr.io/${ghcrUser}/vault-cortex:remote`

const run = (cmd: string): void => {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: "inherit", env })
}

const waitForDocker = (ip: string, id: string, timeoutSec = 120): void => {
  const deadline = Date.now() + timeoutSec * 1000
  console.log(`⏳ Waiting for Docker on ${ip} (up to ${timeoutSec}s)...`)
  while (Date.now() < deadline) {
    try {
      execSync(
        `ssh ${id} ${sshOpts} ubuntu@${ip} 'docker --version' 2>/dev/null`,
        { stdio: "pipe", env },
      )
      console.log(`✓ Docker is ready`)
      return
    } catch {
      execSync("sleep 5")
    }
  }
  console.error(
    `✕ Docker not available on ${ip} after ${timeoutSec}s. Check cloud-init logs.`,
  )
  process.exit(1)
}

const sshHost = (): string => {
  if (env.LIGHTSAIL_SSH_HOST) return env.LIGHTSAIL_SSH_HOST

  if (!existsSync(".sst/stage")) {
    console.error("✕  .sst/stage not found. Run `npx sst deploy` first.")
    process.exit(1)
  }
  const stage = readFileSync(".sst/stage", "utf8").trim()
  // Fetched from AWS rather than read from SST outputs — the IP is
  // deliberately not an output, so deploys never print it (CI logs are
  // public). The static-ip name matches sst.config.ts
  // (`vault-cortex-ip-${stage}`).
  const staticIpName = `vault-cortex-ip-${stage}`
  const ip = execSync(
    `aws lightsail get-static-ip --static-ip-name ${staticIpName} ` +
      `--query staticIp.ipAddress --output text`,
    { env },
  )
    .toString()
    .trim()
  if (!ip || ip === "None") {
    console.error(`✕  Could not resolve ${staticIpName} from AWS.`)
    process.exit(1)
  }
  return ip
}

// Returns `-i <path>` for the SSH identity to use.
// Defaults to ~/.ssh/vault-cortex (the dedicated deploy key that
// matches the Lightsail KeyPair in sst.config.ts). Override with
// LIGHTSAIL_SSH_KEY for a different keypair.
const sshIdentity = (): string => {
  const keyPath = expandHome(env.LIGHTSAIL_SSH_KEY ?? "~/.ssh/vault-cortex")
  if (!existsSync(keyPath)) {
    console.error(
      `✕  SSH key not found: ${keyPath}\n` +
        `  Generate the deploy key:\n` +
        `    ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy`,
    )
    process.exit(1)
  }
  return `-i ${keyPath}`
}

const sshOpts = "-o StrictHostKeyChecking=accept-new"

const sub = process.argv[2]

switch (sub) {
  case "docker:build":
    run(`docker build --target remote --platform linux/amd64 -t ${image} .`)
    break

  case "docker:push":
    run(`docker push ${image}`)
    break

  case "docker:publish":
    run(`docker build --target remote --platform linux/amd64 -t ${image} .`)
    run(`docker push ${image}`)
    break

  case "lightsail:up": {
    if (!existsSync(ENV_PATH)) {
      console.error(
        `✕  ${ENV_PATH} not found.\n` +
          `  Copy .env.example there and fill in values:\n` +
          `  mkdir -p ~/.config/vault-cortex && cp .env.example ~/.config/vault-cortex/.env`,
      )
      process.exit(1)
    }
    const ip = sshHost()
    mask(ip)
    const id = sshIdentity()
    run(
      `ssh ${id} ${sshOpts} ubuntu@${ip} 'sudo mkdir -p /opt/vault-cortex && sudo chown ubuntu:ubuntu /opt/vault-cortex'`,
    )
    waitForDocker(ip, id)
    const ghcrToken = env.GHCR_TOKEN
    if (!ghcrToken) {
      console.error(
        `✕  GHCR_TOKEN not set in ${ENV_PATH}. Needed for docker login on the instance.`,
      )
      process.exit(1)
    }
    console.log(`> docker login ghcr.io -u ${ghcrUser} (on ${ip})`)
    execSync(
      `ssh ${id} ${sshOpts} ubuntu@${ip} 'docker login ghcr.io -u ${ghcrUser} --password-stdin'`,
      { input: ghcrToken, stdio: ["pipe", "pipe", "pipe"], env },
    )
    run(
      `scp ${id} ${sshOpts} docker-compose.yml ubuntu@${ip}:/opt/vault-cortex/`,
    )
    run(`scp ${id} ${sshOpts} ${ENV_PATH} ubuntu@${ip}:/opt/vault-cortex/.env`)
    run(
      `ssh ${id} ${sshOpts} ubuntu@${ip} 'cd /opt/vault-cortex && docker compose pull && docker compose up -d --remove-orphans --wait --wait-timeout 300 && docker image prune -f'`,
    )
    // Deliberately no IP in the success line — the instance IP is kept out
    // of logs (public CI) and is masked above, but not printing it at all is
    // the stronger guarantee.
    console.log("✓ vault-cortex deployed (port 8000)")
    break
  }

  default:
    console.error(
      `Usage: tsx scripts/dev.ts <docker:build|docker:push|docker:publish|lightsail:up>`,
    )
    process.exit(1)
}
