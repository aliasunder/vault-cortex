/** The key hash Obsidian Sync checks a vault password against, derived the
 *  way the obsidian-headless CLI derives it during `ob sync-setup`. The
 *  pinned CLI is the contract — re-verify the scrypt parameters, the HKDF
 *  info string, and the per-version branch on every bump (AGENTS.md →
 *  Upgrading obsidian-headless). */

import { createHash, hkdf, scrypt } from "node:crypto"

/** Encryption scheme versions the pinned Sync client can derive a key for. */
export type SupportedEncryptionVersion = 0 | 2 | 3

/** The newest version the pinned Sync client supports — also what the vault
 *  listing is asked for. A vault above it needs a newer client; a vault
 *  below it that is still unsupported (version 1) does not. */
export const NEWEST_SUPPORTED_ENCRYPTION_VERSION = 3

export const isSupportedEncryptionVersion = (
  value: unknown,
): value is SupportedEncryptionVersion =>
  value === 0 || value === 2 || value === 3

const KEY_LENGTH_BYTES = 32
const SCRYPT_COST = 32_768
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
/** scrypt needs 128 · N · r bytes; at these parameters that is exactly
 *  Node's default `maxmem`, so the limit must be raised or the call throws.
 *  ~32 MiB transient and ~100 ms on the thread pool per derivation. */
const SCRYPT_MAX_MEMORY_BYTES = 128 * SCRYPT_COST * SCRYPT_BLOCK_SIZE * 2

const HKDF_INFO = "ObsidianKeyHash"

const deriveVaultKey = async (
  password: string,
  salt: string,
): Promise<Buffer> => {
  // The client normalizes both inputs, so a password typed with combining
  // characters derives the same key as its precomposed form.
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password.normalize("NFKC"), "utf8"),
      Buffer.from(salt.normalize("NFKC"), "utf8"),
      KEY_LENGTH_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
      },
      (error, derivedKey) => {
        if (error) reject(error)
        else resolve(derivedKey)
      },
    )
  })
}

/** Lowercase hex, 64 characters. The hash is a verifier for the vault
 *  password (the salt is public in the vault listing), so callers never log
 *  it or render it into a page. */
export const deriveVaultKeyHash = async ({
  password,
  salt,
  encryptionVersion,
}: {
  password: string
  salt: string
  encryptionVersion: SupportedEncryptionVersion
}): Promise<string> => {
  const key = await deriveVaultKey(password, salt)
  if (encryptionVersion === 0) {
    return createHash("sha256").update(key).digest("hex")
  }
  const hash = await new Promise<ArrayBuffer>((resolve, reject) => {
    hkdf(
      "sha256",
      key,
      Buffer.from(salt.normalize("NFKC"), "utf8"),
      HKDF_INFO,
      KEY_LENGTH_BYTES,
      (error, derivedKey) => {
        if (error) reject(error)
        else resolve(derivedKey)
      },
    )
  })
  return Buffer.from(hash).toString("hex")
}
