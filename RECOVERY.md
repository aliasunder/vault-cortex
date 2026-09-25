# Recovery

What to do when the Lightsail VM is lost — and what to do when you need to
replace it on purpose. Companion to `sst.config.ts`.

## What's protecting the VM

Three layers cover different failure classes:

| Layer                                 | What it does                                                                                                                                           | Where                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Resource-level `protect: true`        | Refuses any Pulumi op that would destroy/replace the Instance                                                                                          | `sst.config.ts` instance opts |
| Resource-level `retainOnDelete: true` | If SST deletes the Instance once `protect` is cleared (`sst remove`, or removing it from the config), orphan the AWS resource instead of destroying it | `sst.config.ts` instance opts |
| Lightsail auto-snapshot               | Daily disk image at 03:00 UTC, 7-day rolling retention                                                                                                 | `addOn` on the Instance       |

The auto-snapshot is the only one that protects against AWS-side events
(hardware failure, AZ outage) and against in-VM mistakes (fat-finger
`rm -rf`, container compromise). `protect` and `retainOnDelete` only protect
against Pulumi-driven replacement.

## Snapshot policy

- **Cadence:** daily, fixed (Lightsail's auto-snapshot feature has no
  sub-daily option).
- **Retention:** 7 days rolling, automatically (Lightsail caps at 7).
- **What's captured:** the full boot disk — Docker volumes
  (`vault_data`, `mcp_index_data`, `obsidian_config`),
  `/opt/vault-cortex/`, `/etc/`, cron, Tailscale state, anything you
  `apt install`ed in an SSH session. Everything except in-memory state.
- **What's not captured:** running container memory, transient connections.
- **Cost:** ~$0.05/mo at typical usage (snapshot storage is $0.05/GB-month
  on used disk space, not allocated; daily incremental deltas are small).
- **Security:** snapshots inherit account-level IAM access. Treat them as
  sensitive — the disk image contains `/opt/vault-cortex/.env` and
  `oauth.db`. Same handling discipline as the `.env` itself.

## AWS CLI region

Before running any `aws lightsail` command in this guide, export the same
region used by the deployment (`AWS_REGION` in
`~/.config/vault-cortex/.env`, default `us-east-1`):

```bash
export AWS_REGION=<deployment-region>
```

## Restore scenarios

### Scenario A — VM alive, container crashed

Don't restore from snapshot. Just bring the stack back up.

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<static-ip>
cd /opt/vault-cortex
docker compose ps
docker compose up -d
curl -sf http://localhost:8000/healthz
```

### Scenario B — VM broken, restore from latest auto-snapshot

Lightsail deletes an instance's automatic snapshots when the instance is
deleted, so don't delete the broken instance until the restore is verified.

```bash
STAGE=<your-stage>                                # e.g. "production"
INSTANCE_NAME="vault-cortex-${STAGE}"

# These copy availabilityZone and bundleId from sst.config.ts; change them
# only if you changed those values there. The two listings below show the
# zones and bundles your region offers, so confirm both values appear.
AVAILABILITY_ZONE="${AWS_REGION}a"
BUNDLE_ID="medium_3_0"
aws lightsail get-regions --include-availability-zones --region "${AWS_REGION}" --output table
aws lightsail get-bundles --region "${AWS_REGION}" --output table
```

Restore the newest automatic snapshot into a temporary name (the
reconciliation section below then either renames it back or adopts it):

```bash
RESTORE_NAME="${INSTANCE_NAME}-restore-$(date +%s)"

aws lightsail create-instances-from-snapshot \
  --instance-names "${RESTORE_NAME}" \
  --availability-zone "${AVAILABILITY_ZONE}" \
  --bundle-id "${BUNDLE_ID}" \
  --source-instance-name "${INSTANCE_NAME}" \
  --use-latest-restorable-auto-snapshot \
  --key-pair-name "vault-cortex-key-${STAGE}"

# Wait for the new instance to become running before reattaching IP.
aws lightsail get-instance --instance-name "${RESTORE_NAME}" \
  --query 'instance.state.name' --output text
```

The restored instance gets only Lightsail's default firewall rules (SSH and
HTTP open), so port 8000 is closed until the reconcile deploy below restores
the configured rules. If API Gateway reaches the VM on port 8000 (no
`ORIGIN_URL`), open it now:

```bash
aws lightsail open-instance-public-ports --instance-name "${RESTORE_NAME}" \
  --port-info fromPort=8000,toPort=8000,protocol=TCP
```

Reattach the StaticIp (it survives independently of the instance):

```bash
STATIC_IP_NAME="vault-cortex-ip-${STAGE}"

# `|| true`: the IP may already be detached from the broken instance.
aws lightsail detach-static-ip --static-ip-name "${STATIC_IP_NAME}" || true
aws lightsail attach-static-ip \
  --static-ip-name "${STATIC_IP_NAME}" \
  --instance-name "${RESTORE_NAME}"
```

Verify the stack is healthy on the restored VM:

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<static-ip>
cd /opt/vault-cortex && docker compose ps
curl -sf http://localhost:8000/healthz
```

Reconcile SST state so the next deploy uses the new instance — see
"Reconciling SST state after a restore" below.

### Scenario C — VM deleted, or no snapshot to restore

Automatic snapshots expire after 7 days and are deleted along with their
instance. Without a manual snapshot, you're rebuilding from scratch:

```bash
STAGE=<your-stage>                                # the name in .sst/stage
# Remove the stale state entry (the existing state still claims the VM exists)
npm run sst -- state remove VaultCortexVm --stage "${STAGE}"
# Sync SST state with AWS: the static IP attachment and firewall rules went
# with the deleted VM, so the deploy must recreate them too
npm run sst -- refresh --stage "${STAGE}"
# Then a normal deploy provisions a fresh VM
npm run deploy -- --stage "${STAGE}"
```

Then run `npm run docker:publish && npm run lightsail:up`
([DEPLOY.md § Deploy](./DEPLOY.md#deploy)), which copies
`~/.config/vault-cortex/.env` to the new VM and starts the container. Vault content
repopulates automatically via Obsidian Sync on first `vault-cortex`
container start, and the FTS5 index rebuilds itself once the MCP
server boots. OAuth state is gone — clients will re-auth on
their next token refresh.

## Intentional replace (bundle upgrade, blueprint change, etc.)

`protect: true` blocks any deploy that would replace the
Instance. Two approaches depending on how much state you want to preserve:

### Option A — Snapshot-based upgrade (recommended)

Preserves everything on disk: installed packages, Docker volumes,
credentials, SSH keys. The new instance is an exact copy at a larger
bundle. Running processes (tmux sessions, background jobs) do not
survive — only on-disk state carries over.

1. Stop Docker Compose (clean SQLite state for snapshot)
2. Create a manual snapshot of the current instance
3. Create a new instance from the snapshot at the larger bundle
4. Swap the static IP to the new instance
5. Open port 8000 on the new instance (Lightsail firewall rules don't
   carry over from snapshots)
6. If Tailscale is installed: reset state and re-authenticate (snapshot
   restore creates a duplicate node key)
7. Start Docker Compose and verify
8. Update `bundleId` in `sst.config.ts` to the new bundle. (`blueprintId`
   is in `ignoreChanges`, so deploys never act on it; change it only to keep
   the config accurate after an in-place OS upgrade.)
9. Remove the old instance from SST state:
   `npm run sst -- state remove VaultCortexVm --stage "${STAGE}"`
10. In `sst.config.ts`, find `new aws.lightsail.Instance("VaultCortexVm", …)`.
    Set `name` in its instance settings (the first object) to the new
    instance's name. In its options object (the second object, which holds
    `protect: true`), add `import: "<new-instance-name>",` directly above
    `protect: true`; `import` makes the deploy adopt the existing instance
    instead of creating one. Then run `npm run deploy -- --stage "${STAGE}"`.
11. Remove only the `import` line, leaving the new name configured. Run
    `npm run sst -- refresh --stage "${STAGE}"` so SST state records the
    instance's actual settings, then
    `npm run deploy -- --stage "${STAGE}"` again to confirm a clean
    no-diff deploy.
12. Delete the old instance after verification

Steps 9–11 keep the new instance's name, the same result as Path 2 in
"Reconciling SST state" below. Commands elsewhere in this guide and in
DEPLOY.md use the canonical name (`vault-cortex-<stage>`), so substitute the
new name when you run them. To keep the canonical name instead, skip steps
9–12. Once the new instance is verified, follow Path 1, which deletes the old
instance before reusing its name. Set the variables its code block lists as
Scenario B does, but with `RESTORE_NAME` set to the new instance's name and
`BUNDLE_ID` set to the new bundle.

### Option B — SST replace (clean provision)

Provisions a fresh instance from the `userData` bootstrap script. Simpler
but destroys all on-disk state: installed packages, Docker volumes,
`/opt/vault-cortex/.env`, SSH keys, and any ad-hoc tools (Tailscale,
Claude Code, etc.). Only use this if you don't have state worth preserving or
you're comfortable re-provisioning from scratch.

To intentionally replace (e.g. changing `bundleId`):

```bash
# 1. Take a manual snapshot first — the auto-snapshot from up to 23h ago
#    may not be recent enough for what you're about to do.
SNAPSHOT_NAME="pre-upgrade-$(date +%Y%m%d-%H%M%S)"
aws lightsail create-instance-snapshot \
  --instance-name "vault-cortex-${STAGE}" \
  --instance-snapshot-name "${SNAPSHOT_NAME}"

# 2. Lightsail creates the snapshot in the background. Repeat this until it
#    prints "available"; stop if it prints "error".
aws lightsail get-instance-snapshot \
  --instance-snapshot-name "${SNAPSHOT_NAME}" \
  --query 'instanceSnapshot.state' --output text

# 3. In sst.config.ts, remove `protect: true` and `retainOnDelete: true` from
#    the VaultCortexVm options, then deploy with no other change so SST state
#    drops both:
npm run deploy -- --stage "${STAGE}"

# 4. Make the change in sst.config.ts (e.g. bundleId: "large_3_0")
# 5. Deploy — the old instance is deleted and a new one is created.
npm run deploy -- --stage "${STAGE}"

# 6. Restore `protect: true` and `retainOnDelete: true`, then deploy once more
#    so the new instance is protected:
npm run deploy -- --stage "${STAGE}"
```

The replacing deploy deletes the old instance and its automatic snapshots, so
the manual snapshot from step 1 is your only rollback point until the new
instance's first automatic snapshot.

## Reconciling SST state after a restore

After Scenario B, AWS has a new instance with a different name, but SST's
state still references the old name. Choose one of these paths:

**Path 1 — Rename the restored instance back to the canonical name.**
Lightsail can't rename in place, so this means a second snapshot of the
restored VM, then a fresh restore under the canonical name, then a
StaticIp re-attach. This restores the SST-state-matches-reality
invariant. Costs another ~5 minutes and a brief downtime window.

```bash
# Uses STAGE, INSTANCE_NAME, AVAILABILITY_ZONE, BUNDLE_ID, RESTORE_NAME, and
# STATIC_IP_NAME from Scenario B. In a new shell, set them again first.
RESTORED_SNAPSHOT="${RESTORE_NAME}-canonical-$(date +%Y%m%d-%H%M%S)"
aws lightsail create-instance-snapshot \
  --instance-name "${RESTORE_NAME}" \
  --instance-snapshot-name "${RESTORED_SNAPSHOT}"

# Lightsail creates the snapshot in the background. Continue after this
# reports "available"; stop if it reports "error".
aws lightsail get-instance-snapshot \
  --instance-snapshot-name "${RESTORED_SNAPSHOT}" \
  --query 'instanceSnapshot.state' --output text

# The broken instance still holds the canonical name, and Lightsail names are
# unique per region. Delete it now that the restored instance is verified.
aws lightsail delete-instance --instance-name "${INSTANCE_NAME}"

aws lightsail create-instances-from-snapshot \
  --instance-names "${INSTANCE_NAME}" \
  --instance-snapshot-name "${RESTORED_SNAPSHOT}" \
  --availability-zone "${AVAILABILITY_ZONE}" \
  --bundle-id "${BUNDLE_ID}" \
  --key-pair-name "vault-cortex-key-${STAGE}"

# Continue after this reports "running".
aws lightsail get-instance --instance-name "${INSTANCE_NAME}" \
  --query 'instance.state.name' --output text

aws lightsail detach-static-ip --static-ip-name "${STATIC_IP_NAME}"
aws lightsail attach-static-ip \
  --static-ip-name "${STATIC_IP_NAME}" \
  --instance-name "${INSTANCE_NAME}"
aws lightsail delete-instance --instance-name "${RESTORE_NAME}"

npm run sst -- refresh --stage "${STAGE}"
npm run deploy -- --stage "${STAGE}"
```

**Path 2 — Adopt the restored instance into state.**
This preserves the restored name, so configure it explicitly before import:

1. Remove the stale state entry:

   ```bash
   npm run sst -- state remove VaultCortexVm --stage "${STAGE}"
   ```

2. In `sst.config.ts`, find `new aws.lightsail.Instance("VaultCortexVm", …)`
   and set `name` in its instance settings (the first object) to the
   restored instance name (`RESTORE_NAME` from Scenario B).
3. In its options object (the second object, which holds `protect: true`),
   add `import: "<restored-instance-name>",` immediately above
   `protect: true`. `import` makes the next deploy adopt the existing
   instance instead of creating one.
4. Run `npm run deploy -- --stage "${STAGE}"`, then remove the `import`
   line while keeping the restored name.
5. Run `npm run sst -- refresh --stage "${STAGE}"`, followed by
   `npm run deploy -- --stage "${STAGE}"` to confirm a clean no-diff deploy.

SST state and AWS reality now use the restored name. Use Path 1 instead when
the canonical `vault-cortex-<stage>` name must remain the configured name.

For a personal single-stage setup, Path 1 is usually cleanest. For a setup
with several stages sharing one account, Path 2 is faster and avoids the
second downtime.

## Auth implications after any restore

- **Existing JWTs (6h)** keep working until expiry — `/mcp` validation
  is stateless HMAC signature checking. Clients hold these silently.
- **Refresh tokens** are in `oauth.db` on the restored disk. What happens
  next depends on the snapshot:
  - Recent snapshot (Scenario B), `MCP_AUTH_TOKEN` unchanged: refresh tokens
    carry over and clients silently get new JWTs on their next refresh.
  - Snapshot from before refresh tokens were stored under their HMAC key:
    the first boot clears the raw rows and each client re-auths once — when
    its access JWT expires, within 6 hours.
  - Fresh instance with no snapshot to restore (Scenario C): `oauth.db`
    starts empty, so every client re-auths via the consent page on its next
    token refresh — minor inconvenience, no data loss.
- **`MCP_AUTH_TOKEN`** signs access JWTs and keys the lookup of stored
  refresh tokens. The Lambda reads it from the `McpAuthToken` SST secret; the
  instance reads it from `/opt/vault-cortex/.env`, which a restored disk
  already holds and `npm run lightsail:up` or a CI deploy rewrites. If you also rotated it during
  the outage, the rotation rules apply on top of the restore:
  - Existing access JWTs are rejected on their next request — their
    signatures were made with the old secret. Without a rotation they stay
    valid until they expire.
  - Stored refresh tokens can no longer be found.
  - You approve each client again on the consent page the next time it
    connects.

## Verifying the protections work

End-to-end drill. Do this once on a throwaway stage and record the RTO:

```bash
DRILL_STAGE=recovery-drill

# 1. Confirm auto-snapshot is wired up (after first 24h):
aws lightsail get-auto-snapshots \
  --resource-name "vault-cortex-${DRILL_STAGE}"

# 2. Confirm protect blocks a replace-triggering change:
#    (Temporarily change bundleId in sst.config.ts, then:)
npm run deploy -- --stage "${DRILL_STAGE}"
#    Expected: deploy fails with a protected-resource error. Revert the change.

# 3. Confirm the restore path:
#    Stop the VM in the Lightsail console. (Deleting it would also delete
#    its automatic snapshots.)
#    Run Scenario B above.
#    Time the elapsed minutes from "create-instances-from-snapshot" to
#    "/healthz returns 200". Record here:
```

**Last drill:** _not yet performed — record RTO and date here after first run_.
