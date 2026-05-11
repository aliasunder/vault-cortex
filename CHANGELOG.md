# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- **oauth:** 60-day sliding (inactivity) expiry on refresh tokens. Active clients never re-auth; dormant clients re-auth after 60 days. Schema migration adds `expires_at INTEGER NOT NULL` to `refresh_tokens` (#8).
- **sst:** Lightsail durability — daily auto-snapshot (`addOn` AutoSnapshot, 7-day retention) plus Pulumi `protect: true` + `retainOnDelete: true` on the Instance. Captures the full boot disk including ad-hoc SSH-installed packages. New `RECOVERY.md` documents three restore scenarios + intentional-replace flow (#7).

### Refactor

- **oauth:** Migrated date logic to Luxon. Dropped `nowSec()` closure; in-memory state stores `DateTime` objects directly; DB / wire-format integers go through `DateTime.now().plus({...}).toUnixInteger()`. `AUTH_CODE_TTL_MS` → `AUTH_CODE_TTL_S` for unit consistency (#8).

### Tests

- **jwt:** New test suite for `signJwt` / `verifyJwt` — 13 tests covering determinism, header format, payload encoding, signature verification, expiry, tampering, and constant-time mismatch (#8).

## [0.1.2] — 2026-05-11

### Bug Fixes

- **ci:** Inline deploy + release in manual_release so the chain fires (#6)
