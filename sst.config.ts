/// <reference path="./.sst/platform/config.d.ts" />

// SST 4 forbids top-level imports in sst.config.ts — everything has
// to be dynamically imported inside `run()`. See readSshPublicKey
// below for the only filesystem access we need.

// Module-level so app() and run() share the same value.
// env-var can't be used here (SST forbids imports outside run()).
const awsRegion = process.env.AWS_REGION ?? "us-east-1"

export default $config({
  app() {
    return {
      name: "vault-cortex",
      removal: "retain",
      home: "aws",
      providers: { aws: { region: awsRegion } },
    }
  },

  async run() {
    const { readFileSync, existsSync } = await import("node:fs")
    const { homedir } = await import("node:os")
    const env = (await import("env-var")).get

    // ── Environment ──────────────────────────────────────────────
    // SSH key fallback chain: SSH_PUBKEY (CI) → SSH_PUBKEY_PATH → ~/.ssh/vault-cortex.pub
    // Neither is individually required — readSshPublicKey errors if all three miss.
    const sshPubkey = env("SSH_PUBKEY").asString()
    const sshPubkeyPath = env("SSH_PUBKEY_PATH").asString()

    // SSH firewall CIDRs. Comma-separated. Default: open (backward-compat).
    // Set to "none" to block public SSH (Tailscale-only).
    const sshCidrs = env("SSH_CIDRS").asString()

    // MCP port firewall CIDRs. Same format as SSH_CIDRS.
    // Set to "none" to block direct access to port 8000 (use with ORIGIN_URL).
    const mcpPortCidrs = env("MCP_PORT_CIDRS").asString()

    // When set, API Gateway routes through this URL instead of directly to
    // the Lightsail IP on port 8000. Use with a Cloudflare Tunnel, Caddy
    // reverse proxy, or any HTTPS frontend that proxies to localhost:8000.
    const originUrl = env("ORIGIN_URL").asString()

    // Optional custom domain on API Gateway (e.g. mcp.example.com), replacing
    // the auto-generated execute-api URL. DNS stays external (any provider):
    // SST only creates the API Gateway domain + mapping from an existing
    // ACM cert — after deploy, point a CNAME from the domain to the
    // gateway's target hostname (see DEPLOY.md § Custom Domain for the
    // aws CLI command). CUSTOM_DOMAIN_CERT_ARN must be an ISSUED
    // certificate in the API's region covering the name (wildcard or exact).
    const customDomain = env("CUSTOM_DOMAIN").asString()
    const customDomainCertArn = env("CUSTOM_DOMAIN_CERT_ARN").asString()
    if (customDomain && !customDomainCertArn) {
      throw new Error(
        "CUSTOM_DOMAIN requires CUSTOM_DOMAIN_CERT_ARN — the ARN of an " +
          "ISSUED ACM certificate (in this API's region) covering that domain.",
      )
    }

    const expandHome = (p: string): string =>
      p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p

    /**
     * Resolve the SSH public key to upload to Lightsail.
     * Resolution order:
     *   1. SSH_PUBKEY env var (literal key contents) — for CI / GH Actions.
     *   2. SSH_PUBKEY_PATH env var (path) — for local overrides.
     *   3. ~/.ssh/vault-cortex.pub — dedicated deploy key (same key local + CI).
     */
    const readSshPublicKey = (): string => {
      if (sshPubkey) return sshPubkey
      const candidates = sshPubkeyPath
        ? [expandHome(sshPubkeyPath)]
        : [expandHome("~/.ssh/vault-cortex.pub")]
      for (const path of candidates) {
        if (existsSync(path)) return readFileSync(path, "utf8").trim()
      }
      throw new Error(
        `No SSH public key found. Tried env SSH_PUBKEY, then paths: ` +
          `${candidates.join(", ")}. Generate a dedicated deploy key:\n` +
          `  ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy\n` +
          `Or set SSH_PUBKEY_PATH / SSH_PUBKEY to override.`,
      )
    }

    // ── Secrets ────────────────────────────────────────────────────
    // Set once, then deploy:
    //   sst secret set McpAuthToken "$(openssl rand -hex 32)"
    //   sst deploy
    //
    // SST encrypts to S3 in your account. Names MUST be PascalCase.
    // OBSIDIAN_AUTH_TOKEN and VAULT_NAME are NOT SST secrets — they
    // flow to Docker containers via the .env file (local) or GitHub
    // secrets (CI). See deploy.yml and .env.example.
    // ──────────────────────────────────────────────────────────────
    const mcpAuthToken = new sst.Secret("McpAuthToken")

    // ── SSH key pair ──────────────────────────────────────────────
    // Uses a dedicated deploy key (~/.ssh/vault-cortex.pub) shared
    // by local dev and CI. Both sides use the same key so `sst
    // deploy` never sees a key change and never replaces the VM.
    //
    // Setup: ssh-keygen -t ed25519 -f ~/.ssh/vault-cortex -C vault-cortex-deploy
    // CI:    store the public key as SSH_PUBKEY secret, private as SSH_PRIVATE_KEY.
    //
    // To also SSH with your personal key, add it post-provision:
    //   ssh -i ~/.ssh/vault-cortex ubuntu@<IP> \
    //     "cat >> ~/.ssh/authorized_keys" < ~/.ssh/id_ed25519.pub
    //
    // GOTCHA #1: Changing the public key FORCES AN INSTANCE REPLACE.
    //            The VM is destroyed and recreated, wiping Docker
    //            volumes and /opt/vault-cortex. The StaticIp survives.
    // GOTCHA #2: Lightsail resource names are unique ACROSS RESOURCE
    //            TYPES within a region. The `-key` suffix avoids
    //            colliding with the instance name.
    // ──────────────────────────────────────────────────────────────
    const keyPair = new aws.lightsail.KeyPair("VaultCortexKey", {
      name: `vault-cortex-key-${$app.stage}`,
      publicKey: readSshPublicKey(),
    })

    // ── Lightsail ─────────────────────────────────────────────────
    // medium_3_0 = 2 vCPU, 4 GB RAM, 80 GB SSD, 4 TB transfer, $24/mo.
    //
    // Auto-snapshot: daily disk-image backup retained 7 days by
    // Lightsail. Captures everything on the boot disk (Docker volumes,
    // /opt/vault-cortex, /etc edits, ad-hoc apt installs). UTC time —
    // 03:00 UTC = 23:00 ET. Restore path is in RECOVERY.md.
    //
    // protect + retainOnDelete are the IaC seatbelt. `protect` refuses
    // any Pulumi operation that would destroy or replace this resource;
    // `retainOnDelete` orphans the AWS resource if SST ever does decide
    // to delete it (e.g. stage rename) instead of actually destroying.
    // These pair with `removal: "retain"` at the app level — that one
    // only fires on `sst remove`; these fire on every operation.
    //
    // GOTCHA #1: Changing userData, bundleId, or keyPairName WOULD
    //            normally replace the instance. With protect:true,
    //            Pulumi refuses and the deploy fails loudly. For
    //            bundle upgrades, use a snapshot-based upgrade
    //            (preserves all state) then reconcile SST state
    //            afterward — see RECOVERY.md.
    // GOTCHA #2: The deploy-key convention above keeps keyPairName
    //            stable across local and CI deploys.
    // GOTCHA #3: userData is visible via get-instance API/console.
    //            Don't bake secrets here — pull from SSM at boot instead.
    // ──────────────────────────────────────────────────────────────
    const instance = new aws.lightsail.Instance(
      "VaultCortexVm",
      {
        name: `vault-cortex-${$app.stage}`,
        availabilityZone: `${awsRegion}a`,
        blueprintId: "ubuntu_24_04",
        bundleId: "medium_3_0",
        keyPairName: keyPair.name,
        addOn: {
          type: "AutoSnapshot",
          snapshotTime: "03:00",
          status: "Enabled",
        },
        userData: [
          "#!/bin/bash",
          "set -eu",
          "export DEBIAN_FRONTEND=noninteractive",
          "apt-get update -y",
          "apt-get install -y docker.io docker-compose-v2 curl jq",
          "systemctl enable --now docker",
          "usermod -aG docker ubuntu",
          "mkdir -p /opt/vault-cortex",
          "chown ubuntu:ubuntu /opt/vault-cortex",
        ].join("\n"),
        tags: { Project: "vault-cortex", Stage: $app.stage, ManagedBy: "sst" },
      },
      {
        protect: true,
        retainOnDelete: true,
        // Lightsail treats userData and blueprintId as create-time-only
        // properties. Changing either triggers a full instance replacement
        // (not an in-place update). After a snapshot-based bundle upgrade
        // or an in-place OS update, these values in Pulumi state won't
        // match the config — ignore them so deploys stay clean.
        ignoreChanges: ["userData", "blueprintId"],
      },
    )

    const staticIp = new aws.lightsail.StaticIp("VaultCortexIp", {
      name: `vault-cortex-ip-${$app.stage}`,
    })

    new aws.lightsail.StaticIpAttachment("VaultCortexIpAttach", {
      staticIpName: staticIp.name,
      instanceName: instance.name,
    })

    /** RFC 5737 TEST-NET — no real source IP matches this CIDR. */
    const NON_ROUTABLE_CIDR = "192.0.2.1/32"
    const OPEN_TO_ALL = ["0.0.0.0/0"]

    /**
     * Parse a CIDR env var into a firewall allowlist.
     * - undefined → open to all
     * - "none" → non-routable CIDR (blocks all public access)
     * - "a/b,c/d" → split into individual CIDRs
     *
     * Host-level services (tunnels, VPNs) bypass the Lightsail firewall.
     */
    const parseCidrs = (raw: string | undefined): string[] => {
      if (!raw) return OPEN_TO_ALL
      if (raw.toLowerCase() === "none") return [NON_ROUTABLE_CIDR]
      return raw.split(",").map((cidr) => cidr.trim())
    }

    const sshFirewallCidrs = parseCidrs(sshCidrs)
    const mcpFirewallCidrs = parseCidrs(mcpPortCidrs)

    // GOTCHA: port_info is ForceNew in the Pulumi/Terraform provider.
    // Adding or removing entries triggers a REPLACEMENT, and the
    // default create-before-delete order wipes newly created ports
    // (PutInstancePublicPorts is a replace-all API). pulumi/pulumi-aws#1511.
    // Two defenses:
    //   1. Always keep both entries — "none" changes cidrs only (not ForceNew).
    //   2. deleteBeforeReplace — if replacement is ever triggered,
    //      delete runs first so create sets the final state.
    new aws.lightsail.InstancePublicPorts(
      "VaultCortexPorts",
      {
        instanceName: instance.name,
        portInfos: [
          {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrs: sshFirewallCidrs,
          },
          // MCP_PORT_CIDRS controls who can reach port 8000 directly.
          // With ORIGIN_URL set (tunnel/proxy), set MCP_PORT_CIDRS=none
          // to block direct access — traffic flows through the tunnel.
          // Without ORIGIN_URL, 0.0.0.0/0 is the default (API GW needs it).
          {
            protocol: "tcp",
            fromPort: 8000,
            toPort: 8000,
            cidrs: mcpFirewallCidrs,
          },
        ],
      },
      // Prevents create-before-delete from wiping ports. See GOTCHA above.
      { deleteBeforeReplace: true },
    )

    // Stage throttle: 20 req/sec, 40 burst. GOTCHA: throttlingRateLimit
    // and throttlingBurstLimit must BOTH be set — partial config is
    // interpreted as 0 and rejects all traffic (pulumi/pulumi-aws#2363).
    const api = new sst.aws.ApiGatewayV2("VaultCortexApi", {
      // dns: false — SST skips DNS record creation (records live with the
      // external DNS provider) and requires the pre-issued cert instead of
      // provisioning one. The default execute-api endpoint stays active.
      ...(customDomain &&
        customDomainCertArn && {
          domain: {
            name: customDomain,
            dns: false,
            cert: customDomainCertArn,
          },
        }),
      transform: {
        stage: {
          defaultRouteSettings: {
            throttlingRateLimit: 20,
            throttlingBurstLimit: 40,
          },
        },
      },
    })

    // Lambda authorizer — validates Bearer tokens (static MCP_AUTH_TOKEN
    // or JWT) on protected routes only. OAuth discovery paths are wired as
    // separate unauthenticated routes below, so the authorizer no longer
    // needs to pass them through (it keeps the path check as defense in
    // depth). Express also validates in-process via requireBearerAuth.
    //
    // identitySources is the load-bearing detail: with the Authorization
    // header registered as the identity source, API Gateway answers
    // tokenless requests with an automatic 401 Unauthorized — without
    // invoking the Lambda. MCP clients (Claude, etc.) require a 401 on the
    // initial unauthenticated probe to enter the OAuth connect flow; they
    // fall back to /.well-known/oauth-protected-resource discovery when no
    // WWW-Authenticate header is present (RFC 9728 default location).
    // A Lambda-authorizer deny, by contrast, is a fixed 403 Forbidden that
    // HTTP APIs cannot customize — clients treat it as a broken server.
    const authorizer = api.addAuthorizer({
      name: "bearer-auth",
      lambda: {
        function: {
          handler: "src/functions/authorizer.handler",
          link: [mcpAuthToken],
          runtime: "nodejs24.x",
          timeout: "5 seconds",
          memory: "128 MB",
        },
        identitySources: ["$request.header.Authorization"],
      },
    })

    // ORIGIN_URL: when set, API GW routes through a tunnel/proxy (HTTPS)
    // instead of directly to the Lightsail IP (plaintext HTTP). Pair with
    // MCP_PORT_CIDRS=none to close port 8000 on the firewall.
    const target = (path: string) =>
      originUrl
        ? `${originUrl}${path}`
        : $interpolate`http://${staticIp.ipAddress}:8000${path}`

    // ── Open routes — no authorizer ──────────────────────────────
    // OAuth discovery/flow endpoints must be reachable unauthenticated
    // (MCP/OAuth spec). Express owns their logic — DCR, consent, token
    // validation, and 5 req/min rate limiting. API Gateway always picks
    // the most specific matching route, so these win over the protected
    // catch-alls below regardless of declaration order.
    for (const path of [
      "/authorize",
      "/token",
      "/register",
      "/revoke",
      "/healthz",
    ]) {
      api.routeUrl(`ANY ${path}`, target(path))
    }
    api.routeUrl("ANY /.well-known/{proxy+}", target("/.well-known/{proxy}"))
    api.routeUrl("ANY /oauth/{proxy+}", target("/oauth/{proxy}"))

    // ── Protected routes — Lambda authorizer ─────────────────────
    // GOTCHA: {proxy+} matches one-or-more path segments but NOT
    // the bare root "/". You need both routes.
    api.routeUrl("ANY /{proxy+}", target("/{proxy}"), {
      auth: { lambda: authorizer.id },
    })
    api.routeUrl("ANY /", target(""), {
      auth: { lambda: authorizer.id },
    })

    // Deliberately NOT outputs: the Lightsail IP and the custom domain's
    // CNAME target. SST prints outputs at the end of every deploy — in CI
    // that means public Actions logs. Fetch them from AWS instead:
    //   aws lightsail get-static-ip --static-ip-name vault-cortex-ip-<stage> \
    //     --query staticIp.ipAddress --output text
    //   aws apigatewayv2 get-domain-name --domain-name <CUSTOM_DOMAIN> \
    //     --query 'DomainNameConfigurations[0].ApiGatewayDomainName' --output text
    return {
      apiUrl: api.url,
    }
  },
})
