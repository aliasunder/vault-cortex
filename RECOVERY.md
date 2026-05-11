# Recovery

What to do when the Lightsail VM is lost — and what to do when you need to
replace it on purpose. Companion to `sst.config.ts`.

## What's protecting the VM

Three layers cover different failure classes:

| Layer                                 | What it does                                                                                    | Where                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------- |
| App-level `removal: "retain"`         | Blocks `sst remove` from destroying the stack                                                   | `sst.config.ts` `app()`       |
| Resource-level `protect: true`        | Refuses any Pulumi op that would destroy/replace the Instance                                   | `sst.config.ts` instance opts |
| Resource-level `retainOnDelete: true` | If SST ever does decide to delete (stage rename), orphan the AWS resource instead of destroying | `sst.config.ts` instance opts |
| Lightsail auto-snapshot               | Daily disk image at 03:00 UTC, 7-day rolling retention                                          | `addOn` on the Instance       |

The auto-snapshot is the only one that protects against AWS-side events
(hardware failure, AZ outage) and against in-VM mistakes (fat-finger
`rm -rf`, container compromise). The IaC seatbelts only protect against
Pulumi-driven replacement.

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

## Restore scenarios

### Scenario A — VM alive, containers crashed

Don't restore from snapshot. Just bring the stack back up.

```bash
ssh -i ~/.ssh/vault-cortex ubuntu@<static-ip>
cd /opt/vault-cortex
docker compose ps
docker compose up -d
curl -sf http://localhost:8000/healthz
```

### Scenario B — VM gone, restore from latest auto-snapshot

Lightsail auto-snapshots use a deterministic name format
(`<instance-name>-auto-<timestamp>`). Find the most recent one for your
stage:

```bash
STAGE=<your-stage>                                # e.g. "production"
INSTANCE_NAME="vault-cortex-${STAGE}"

aws lightsail get-auto-snapshots \
  --resource-name "${INSTANCE_NAME}" \
  --output json \
  | jq -r '.autoSnapshots[0].date'                # date of newest snapshot
```

Restore into a temporary name (Lightsail can't reuse the original name
while SST still has the old resource in state):

```bash
SNAPSHOT_DATE=<from above>
RESTORE_NAME="${INSTANCE_NAME}-restore-$(date +%s)"

aws lightsail create-instances-from-snapshot \
  --instance-names "${RESTORE_NAME}" \
  --availability-zone us-east-1a \
  --bundle-id small_3_0 \
  --source-instance-name "${INSTANCE_NAME}" \
  --restore-date "${SNAPSHOT_DATE}" \
  --key-pair-name "vault-cortex-key-${STAGE}"

# Wait for the new instance to become running before reattaching IP.
aws lightsail get-instance --instance-name "${RESTORE_NAME}" \
  --query 'instance.state.name' --output text
```

Reattach the StaticIp (it survives independently of the instance):

```bash
STATIC_IP_NAME="vault-cortex-ip-${STAGE}"

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

### Scenario C — VM gone AND the auto-snapshot has aged out

Auto-snapshots expire after 7 days. If the VM has been gone longer and
you have no manual snapshot, you're rebuilding from scratch:

```bash
# Unprotect (since the existing state still claims the VM exists)
sst state remove --target 'aws:lightsail:Instance::VaultCortexVm'
# Then a normal deploy provisions a fresh VM
npx sst deploy --stage "${STAGE}"
```

You'll need to re-run the post-provision steps from the README
(populate `.env`, `docker compose up -d`, etc.). Vault content
repopulates automatically via Obsidian Sync on first
`obsidian-sync` container start. The FTS5 index rebuilds itself on
first `vault-mcp` start. OAuth state is gone — clients will re-auth on
their next token refresh.

## Intentional replace (bundle upgrade, blueprint change, etc.)

The `protect: true` seatbelt blocks any deploy that would replace the
Instance. To intentionally replace (e.g. Phase 2 bundle upgrade from
`small_3_0` 2 GB → `medium_3_0` 4 GB):

```bash
# 1. Take a manual snapshot first — the auto-snapshot from up to 23h ago
#    may not be recent enough for what you're about to do.
aws lightsail create-instance-snapshot \
  --instance-name "vault-cortex-${STAGE}" \
  --instance-snapshot-name "pre-upgrade-$(date +%Y%m%d-%H%M%S)"

# 2. Unprotect the resource in Pulumi state
sst state unprotect --target 'aws:lightsail:Instance::VaultCortexVm'

# 3. Make the change in sst.config.ts (e.g. bundleId: "medium_3_0")
# 4. Deploy — this is the one and only time replacement is allowed.
npx sst deploy --stage "${STAGE}"

# 5. Re-protect on the next normal deploy. The protect:true line in
#    sst.config.ts is still there, so deploy with no changes:
npx sst deploy --stage "${STAGE}"
```

If `sst state unprotect` isn't available in your SST version, drop to
Pulumi directly:

```bash
# SST stores Pulumi state in S3 under the SST-managed bucket.
# The Pulumi CLI inherits credentials from the same AWS profile.
pulumi state unprotect 'urn:pulumi:<stage>::vault-cortex::aws:lightsail/instance:Instance::VaultCortexVm'
```

The URN follows the pattern
`urn:pulumi:<stage>::<app-name>::<resource-type>::<logical-name>`.

## Reconciling SST state after a restore

After Scenario B, AWS has a new instance with a different name, but SST's
state still references the old name. Two paths depending on how much
drift you're willing to keep:

**Path 1 — Rename the restored instance back to the canonical name.**
Lightsail can't rename in place, so this means a second snapshot of the
restored VM, then a fresh restore under the canonical name, then a
StaticIp re-attach. This restores the SST-state-matches-reality
invariant. Costs another ~5 minutes and a brief downtime window.

**Path 2 — Adopt the restored instance into state.**
Update `sst.config.ts` to point at the restored name (e.g. via a stage
override), `sst refresh` to pick up actual cloud state, then deploy. SST
state and AWS reality converge without further AWS-side changes.

For a personal single-stage setup, Path 1 is usually cleanest. For
production-style multi-stage, Path 2 is faster and avoids the second
downtime.

## Auth implications after any restore

- **Existing JWTs (24h)** keep working until expiry — `/mcp` validation
  is stateless HMAC signature checking. Clients hold these silently.
- **Refresh tokens** are in `oauth.db` on the restored disk. If the
  snapshot is recent (Scenario B), refresh tokens carry over and clients
  silently get new JWTs on their next refresh cycle. If the DB is gone
  (Scenario C), every client re-auths via the consent page on its next
  token refresh — minor inconvenience, no data loss.
- **`MCP_AUTH_TOKEN`** is the JWT signing HMAC key. It's in SST secrets
  and gets redeployed to `/opt/vault-cortex/.env` on any fresh boot. If
  you rotated it during the outage, all existing JWTs die immediately
  and every client re-auths on their next call.

## Verifying the seatbelts work

End-to-end drill. Do this once on a throwaway stage and record the RTO:

```bash
DRILL_STAGE=recovery-drill

# 1. Confirm auto-snapshot is wired up (after first 24h):
aws lightsail get-auto-snapshots \
  --resource-name "vault-cortex-${DRILL_STAGE}"

# 2. Confirm protect blocks a replace-triggering change:
#    (Temporarily tweak userData in sst.config.ts, then:)
npx sst deploy --stage "${DRILL_STAGE}"
#    Expected: deploy fails with a protected-resource error. Revert the change.

# 3. Confirm the restore path:
#    Delete the VM via console (after unprotect, since protect:true is on).
#    Run Scenario B above.
#    Time the elapsed minutes from "create-instances-from-snapshot" to
#    "/healthz returns 200". Record here:
```

**Last drill:** _not yet performed — record RTO and date here after first run_.
