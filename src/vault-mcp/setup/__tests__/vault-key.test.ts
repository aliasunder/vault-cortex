import { describe, expect, it } from "vitest"
import {
  deriveVaultKeyHash,
  isSupportedEncryptionVersion,
} from "../vault-key.js"

// Expected values computed with the pinned obsidian-headless CLI's own
// derivation for the same inputs; the test owns them so the module cannot
// be its own oracle.
const PASSWORD = "correct horse battery"
const SALT = "vault-salt-1"
const KEY_HASH_V3 =
  "60aa76a8ebdc3bd3fff0670081c08bc8056407f765a1c7b0918cc7077639a398" // gitleaks:allow
const KEY_HASH_V0 =
  "70e71fbaf4e6016807c7d24edd32dce10c0c1f7491ccea42a848f7d078990490" // gitleaks:allow
const NON_ASCII_KEY_HASH_V3 =
  "8d8534f8d78a42c892f4edb0b0c9adbb3554954bfab6c09d708c93aa8e633f5a" // gitleaks:allow

describe("deriveVaultKeyHash", () => {
  it("matches the Sync client's hash for encryption version 3", async () => {
    await expect(
      deriveVaultKeyHash({
        password: PASSWORD,
        salt: SALT,
        encryptionVersion: 3,
      }),
    ).resolves.toBe(KEY_HASH_V3)
  })

  it("uses the same HKDF branch for version 2 as for version 3", async () => {
    await expect(
      deriveVaultKeyHash({
        password: PASSWORD,
        salt: SALT,
        encryptionVersion: 2,
      }),
    ).resolves.toBe(KEY_HASH_V3)
  })

  it("hashes the derived key directly for encryption version 0", async () => {
    await expect(
      deriveVaultKeyHash({
        password: PASSWORD,
        salt: SALT,
        encryptionVersion: 0,
      }),
    ).resolves.toBe(KEY_HASH_V0)
  })

  it("normalizes the password so combining characters derive the precomposed form's hash", async () => {
    const precomposed = "pässwörd"
    const decomposed = "pa\u0308sswo\u0308rd"
    expect(decomposed).not.toBe(precomposed)

    await expect(
      deriveVaultKeyHash({
        password: precomposed,
        salt: "salt",
        encryptionVersion: 3,
      }),
    ).resolves.toBe(NON_ASCII_KEY_HASH_V3)
    await expect(
      deriveVaultKeyHash({
        password: decomposed,
        salt: "salt",
        encryptionVersion: 3,
      }),
    ).resolves.toBe(NON_ASCII_KEY_HASH_V3)
  })

  it("derives a different hash for a different password", async () => {
    await expect(
      deriveVaultKeyHash({
        password: "wrong horse battery",
        salt: SALT,
        encryptionVersion: 3,
      }),
    ).resolves.not.toBe(KEY_HASH_V3)
  })
})

describe("isSupportedEncryptionVersion", () => {
  it("accepts the versions the pinned client derives keys for", () => {
    expect([0, 2, 3].map(isSupportedEncryptionVersion)).toEqual([
      true,
      true,
      true,
    ])
  })

  it("rejects other numbers, strings, and absent values", () => {
    expect(
      [1, 4, "3", undefined, null].map(isSupportedEncryptionVersion),
    ).toEqual([false, false, false, false, false])
  })
})
