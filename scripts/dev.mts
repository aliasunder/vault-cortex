#!/usr/bin/env tsx
/**
 * Personal-stage deployment helper.
 *
 * Subcommands:
 *   docker:build    Build the vault-mcp image locally
 *   docker:push     Push to GHCR
 *   docker:publish  Build + push
 *   lightsail:up    SCP docker-compose.yml + .env to the VM, then
 *                   `docker compose pull && up -d` over SSH
 *
 * The image tag is `ghcr.io/${GHCR_USER}/vault-mcp:${VAULT_MCP_TAG}`,
 * sourced from `.env` (or process env). The Lightsail IP is read
 * from `.sst/outputs.json`, which SST writes after a successful
 * `sst deploy` (or `sst dev`).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

type SstOutputs = { lightsailIp?: string; apiUrl?: string };

const loadDotEnv = (): Record<string, string> => {
  if (!existsSync(".env")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/i.exec(line.trim());
    if (match) out[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
};

const expandHome = (p: string): string =>
  p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;

const env: NodeJS.ProcessEnv = { ...process.env, ...loadDotEnv() };
const ghcrUser = env.GHCR_USER ?? "aliasunder";
const tag = env.VAULT_MCP_TAG ?? "dev";
const image = `ghcr.io/${ghcrUser}/vault-mcp:${tag}`;

const run = (cmd: string): void => {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", env });
};

const lightsailIp = (): string => {
  if (!existsSync(".sst/outputs.json")) {
    console.error("✕  .sst/outputs.json not found. Run `npx sst deploy` first.");
    process.exit(1);
  }
  const outs = JSON.parse(
    readFileSync(".sst/outputs.json", "utf8"),
  ) as SstOutputs;
  if (!outs.lightsailIp) {
    console.error("✕  lightsailIp missing from SST outputs.");
    process.exit(1);
  }
  return outs.lightsailIp;
};

const sshIdentity = (): string => {
  if (!env.LIGHTSAIL_SSH_KEY) {
    console.error(
      "✕  LIGHTSAIL_SSH_KEY not set. Download the Lightsail default key\n" +
        "   from AWS console → Account → SSH keys, save it to ~/.ssh/,\n" +
        "   chmod 600 it, and add to .env:\n" +
        "     LIGHTSAIL_SSH_KEY=~/.ssh/LightsailDefaultKey-us-east-1.pem",
    );
    process.exit(1);
  }
  const path = expandHome(env.LIGHTSAIL_SSH_KEY);
  if (!existsSync(path)) {
    console.error(`✕  LIGHTSAIL_SSH_KEY path does not exist: ${path}`);
    process.exit(1);
  }
  return `-i ${path}`;
};

const sshOpts = "-o StrictHostKeyChecking=accept-new";

const sub = process.argv[2];

switch (sub) {
  case "docker:build":
    run(`docker build -t ${image} .`);
    break;

  case "docker:push":
    run(`docker push ${image}`);
    break;

  case "docker:publish":
    run(`docker build -t ${image} .`);
    run(`docker push ${image}`);
    break;

  case "lightsail:up": {
    if (!existsSync(".env")) {
      console.error("✕  .env not found. Copy .env.example and fill in values.");
      process.exit(1);
    }
    const ip = lightsailIp();
    const id = sshIdentity();
    run(`scp ${id} ${sshOpts} docker-compose.yml ubuntu@${ip}:/opt/vault-cortex/`);
    run(`scp ${id} ${sshOpts} .env ubuntu@${ip}:/opt/vault-cortex/`);
    run(
      `ssh ${id} ${sshOpts} ubuntu@${ip} 'cd /opt/vault-cortex && docker compose pull && docker compose up -d'`,
    );
    console.log(`✓ vault-mcp deployed to ${ip}:8000`);
    break;
  }

  default:
    console.error(
      `Usage: tsx scripts/dev.mts <docker:build|docker:push|docker:publish|lightsail:up>`,
    );
    process.exit(1);
}
