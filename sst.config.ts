/// <reference path="./.sst/platform/config.d.ts" />

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
    // -- Secrets --------------------------------------------------------
    // Set once per stage:
    //   sst secret set McpAuthToken "$(openssl rand -hex 32)"
    //   sst secret set ObsidianAuthToken "<from Belphemur get-token>"
    //   sst secret set ObsidianVaultName "My Vault"
    //
    // PascalCase required. Encrypted in SST-managed S3.
    // -------------------------------------------------------------------
    const mcpAuthToken = new sst.Secret("McpAuthToken");
    const obsidianAuthToken = new sst.Secret("ObsidianAuthToken");
    const obsidianVaultName = new sst.Secret("ObsidianVaultName");

    // -- Lightsail ------------------------------------------------------
    // Small = 2 vCPU, 2 GB RAM, 60 GB SSD, $12/mo.
    // GOTCHA: Changing userData or bundleId REPLACES the instance.
    // GOTCHA: userData is visible in console — don't put secrets here.
    // -------------------------------------------------------------------
    const instance = new aws.lightsail.Instance("VaultCortexVm", {
      name: `vault-cortex-${$app.stage}`,
      availabilityZone: "us-east-1a",
      blueprintId: "ubuntu_22_04",
      bundleId: "small_3_0",
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

    // GOTCHA: InstancePublicPorts is DECLARATIVE — replaces ALL rules.
    // Omitting port 22 locks you out of SSH.
    new aws.lightsail.InstancePublicPorts("VaultCortexPorts", {
      instanceName: instance.name,
      portInfos: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] }, // TODO: restrict to admin IP
        { protocol: "tcp", fromPort: 8000, toPort: 8000, cidrs: ["0.0.0.0/0"] },
      ],
    });

    // -- API Gateway HTTP API --------------------------------------------
    // No custom domain — auto-generated HTTPS URL.
    // Free tier: 1M req/mo for 12 months, then $1/M.
    // -------------------------------------------------------------------
    const api = new sst.aws.ApiGatewayV2("VaultCortexApi");

    const authorizer = api.addAuthorizer({
      name: "bearer-auth",
      lambda: {
        function: {
          handler: "packages/functions/src/authorizer.handler",
          link: [mcpAuthToken],
          runtime: "nodejs22.x",
          timeout: "5 seconds",
          memory: "128 MB",
        },
      },
    });

    // GOTCHA: {proxy+} matches 1+ segments, not bare "/". Need both routes.
    api.routeUrl("ANY /{proxy+}", $interpolate`http://${staticIp.ipAddress}:8000/{proxy}`, {
      auth: { lambda: authorizer.id },
    });
    api.routeUrl("ANY /", $interpolate`http://${staticIp.ipAddress}:8000`, {
      auth: { lambda: authorizer.id },
    });

    return {
      apiUrl: api.url,
      lightsailIp: staticIp.ipAddress,
    };
  },
});
