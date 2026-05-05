/// <reference path="./.sst/platform/config.d.ts" />

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const expandHome = (p: string): string =>
  p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;

const readSshPublicKey = (): string => {
  // Resolution order:
  //   1. SSH_PUBKEY env var (literal key contents) — for CI / GitHub Actions
  //      where the key comes from a secret, not the filesystem.
  //   2. SSH_PUBKEY_PATH env var (path) — for local overrides.
  //   3. ~/.ssh/id_ed25519.pub, then ~/.ssh/id_rsa.pub — defaults for
  //      local dev.
  if (process.env.SSH_PUBKEY?.trim()) {
    return process.env.SSH_PUBKEY.trim();
  }
  const candidates = process.env.SSH_PUBKEY_PATH
    ? [expandHome(process.env.SSH_PUBKEY_PATH)]
    : [
        expandHome("~/.ssh/id_ed25519.pub"),
        expandHome("~/.ssh/id_rsa.pub"),
      ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  throw new Error(
    `No SSH public key found. Tried env SSH_PUBKEY, then paths: ` +
      `${candidates.join(", ")}. Either generate a key ` +
      `(\`ssh-keygen -t ed25519\`), set SSH_PUBKEY_PATH to a ` +
      `.pub file, or pass SSH_PUBKEY directly (CI).`,
  );
};

export default $config({
  app(input) {
    return {
      name: "vault-cortex",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: { aws: { region: "us-east-1" } },
    };
  },

  async run() {
    // ── Secrets ────────────────────────────────────────────────────
    // Set once per stage, then deploy:
    //   sst secret set McpAuthToken "$(openssl rand -hex 32)" --stage production
    //   sst secret set ObsidianAuthToken "<from Belphemur get-token>" --stage production
    //   sst secret set ObsidianVaultName "My Vault" --stage production
    //   sst deploy --stage production
    //
    // SST encrypts to S3 in your account. Names MUST be PascalCase.
    // ──────────────────────────────────────────────────────────────
    const mcpAuthToken = new sst.Secret("McpAuthToken");
    const obsidianAuthToken = new sst.Secret("ObsidianAuthToken");
    const obsidianVaultName = new sst.Secret("ObsidianVaultName");

    // ── SSH key pair ──────────────────────────────────────────────
    // Uploads the developer's local public key (id_ed25519.pub by
    // default; override via SSH_PUBKEY_PATH) so SCP/SSH "just work"
    // with the default identity — no `-i` flag, no per-region
    // LightsailDefaultKey.pem download.
    //
    // GOTCHA: Changing keyPairName on an existing Lightsail Instance
    //         FORCES A REPLACE. The VM is destroyed and recreated,
    //         wiping its local disk (Docker volumes, /opt/vault-cortex
    //         contents). The StaticIp stays (separate resource).
    // ──────────────────────────────────────────────────────────────
    const keyPair = new aws.lightsail.KeyPair("VaultCortexKey", {
      name: `vault-cortex-${$app.stage}`,
      publicKey: readSshPublicKey(),
    });

    // ── Lightsail ─────────────────────────────────────────────────
    // small_3_0 = 2 vCPU, 2 GB RAM, 60 GB SSD, 3 TB transfer, $12/mo.
    //
    // GOTCHA: Changing userData, bundleId, or keyPairName REPLACES
    //         the instance — all data on the old instance is lost.
    // GOTCHA: userData is visible via get-instance API/console.
    //         Don't bake secrets here — pull from SSM at boot instead.
    // ──────────────────────────────────────────────────────────────
    const instance = new aws.lightsail.Instance("VaultCortexVm", {
      name: `vault-cortex-${$app.stage}`,
      availabilityZone: "us-east-1a",
      blueprintId: "ubuntu_22_04",
      bundleId: "small_3_0",
      keyPairName: keyPair.name,
      userData: [
        "#!/bin/bash",
        "set -euo pipefail",
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get update -y",
        "apt-get install -y docker.io docker-compose-v2 curl jq",
        "systemctl enable --now docker",
        "usermod -aG docker ubuntu",
        "mkdir -p /opt/vault-cortex",
        "chown ubuntu:ubuntu /opt/vault-cortex",
      ].join("\n"),
      tags: { Project: "vault-cortex", Stage: $app.stage, ManagedBy: "sst" },
    });

    const staticIp = new aws.lightsail.StaticIp("VaultCortexIp", {
      name: `vault-cortex-ip-${$app.stage}`,
    });

    new aws.lightsail.StaticIpAttachment("VaultCortexIpAttach", {
      staticIpName: staticIp.name,
      instanceName: instance.name,
    });

    // GOTCHA: InstancePublicPorts is DECLARATIVE — it replaces ALL
    // existing rules on every deploy. If you omit port 22 here,
    // you lock yourself out of SSH permanently.
    new aws.lightsail.InstancePublicPorts("VaultCortexPorts", {
      instanceName: instance.name,
      portInfos: [
        // TODO: Restrict SSH to your admin IP (e.g. "203.0.113.42/32")
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] },
        // API Gateway calls Lightsail on this port. Bearer token is
        // enforced upstream by the Lambda authorizer, so 0.0.0.0/0
        // is acceptable — the token is the real security boundary.
        { protocol: "tcp", fromPort: 8000, toPort: 8000, cidrs: ["0.0.0.0/0"] },
      ],
    });

    // ── API Gateway HTTP API ──────────────────────────────────────
    // No custom domain — you get a free HTTPS URL:
    //   https://<id>.execute-api.us-east-1.amazonaws.com
    //
    // Free tier: 1M requests/mo for 12 months, then $1/M (HTTP API).
    // MCP clients point at this URL with their bearer token.
    // ──────────────────────────────────────────────────────────────
    const api = new sst.aws.ApiGatewayV2("VaultCortexApi");

    const authorizer = api.addAuthorizer({
      name: "bearer-auth",
      lambda: {
        function: {
          // SST bundles this with esbuild — only authorizer.ts and
          // its imports end up in the Lambda. vault-mcp/ is excluded.
          handler: "src/functions/authorizer.handler",
          link: [mcpAuthToken],
          runtime: "nodejs22.x",
          timeout: "5 seconds",
          memory: "128 MB",
        },
      },
    });

    // routeUrl() creates an HTTP_PROXY integration — API Gateway
    // forwards the request as-is to the Lightsail backend.
    //
    // GOTCHA: {proxy+} matches one-or-more path segments but NOT
    // the bare root "/". You need both routes.
    api.routeUrl(
      "ANY /{proxy+}",
      $interpolate`http://${staticIp.ipAddress}:8000/{proxy}`,
      { auth: { lambda: authorizer.id } },
    );
    api.routeUrl(
      "ANY /",
      $interpolate`http://${staticIp.ipAddress}:8000`,
      { auth: { lambda: authorizer.id } },
    );

    return {
      apiUrl: api.url,
      lightsailIp: staticIp.ipAddress,
    };
  },
});
