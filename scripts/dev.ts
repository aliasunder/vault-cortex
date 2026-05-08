#!/usr/bin/env tsx
/**
 * Deployment helper.
 *
 * Subcommands:
 *   docker:build    Build the vault-mcp image locally
 *   docker:push     Push to GHCR
 *   docker:publish  Build + push
 *   lightsail:up    SCP docker-compose.yml + ~/.config/vault-cortex/.env
 *                   to the VM, then `docker compose pull && up -d` over SSH
 *
 * The image is always `ghcr.io/${GHCR_USER}/vault-mcp:latest`. The
 * Lightsail IP is read from `.sst/outputs.json`, which SST writes
 * after a successful `sst deploy` (or `sst dev`).
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type SstOutputs = { lightsailIp?: string; apiUrl?: string }

const ENV_PATH = join(homedir(), ".config", "vault-cortex", ".env")

const loadDotEnv = (): Record<string, string> => {
  if (!existsSync(ENV_PATH)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/i.exec(line.trim())
    if (match) out[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "")
  }
  return out
}

const expandHome = (p: string): string =>
  p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p

const env: NodeJS.ProcessEnv = { ...loadDotEnv(), ...process.env }
const ghcrUser = env.GHCR_USER ?? "aliasunder"
const image = `ghcr.io/${ghcrUser}/vault-mcp:latest`

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

const lightsailIp = (): string => {
  if (!existsSync(".sst/outputs.json")) {
    console.error("✕  .sst/outputs.json not found. Run `npx sst deploy` first.")
    process.exit(1)
  }
  const outs = JSON.parse(
    readFileSync(".sst/outputs.json", "utf8"),
  ) as SstOutputs
  if (!outs.lightsailIp) {
    console.error("✕  lightsailIp missing from SST outputs.")
    process.exit(1)
  }
  return outs.lightsailIp
}

// Returns `-i <path>` when LIGHTSAIL_SSH_KEY is set, else "".
// Default deploys provision a Lightsail KeyPair from the developer's
// local public key (see sst.config.ts), so SSH/SCP work with the
// default identity. Set LIGHTSAIL_SSH_KEY only if you're connecting
// to an instance provisioned with a different keypair (e.g. the
// regional LightsailDefaultKey for a pre-existing VM).
const sshIdentity = (): string => {
  if (!env.LIGHTSAIL_SSH_KEY) return ""
  const path = expandHome(env.LIGHTSAIL_SSH_KEY)
  if (!existsSync(path)) {
    console.error(`✕  LIGHTSAIL_SSH_KEY path does not exist: ${path}`)
    process.exit(1)
  }
  return `-i ${path}`
}

const sshOpts = "-o StrictHostKeyChecking=accept-new"

const sub = process.argv[2]

switch (sub) {
  case "docker:build":
    run(`docker build --platform linux/amd64 -t ${image} .`)
    break

  case "docker:push":
    run(`docker push ${image}`)
    break

  case "docker:publish":
    run(`docker build --platform linux/amd64 -t ${image} .`)
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
    const ip = lightsailIp()
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
      `ssh ${id} ${sshOpts} ubuntu@${ip} 'cd /opt/vault-cortex && docker compose pull && docker compose up -d'`,
    )
    console.log(`✓ vault-mcp deployed to ${ip}:8000`)
    break
  }

  default:
    console.error(
      `Usage: tsx scripts/dev.mts <docker:build|docker:push|docker:publish|lightsail:up>`,
    )
    process.exit(1)
}
