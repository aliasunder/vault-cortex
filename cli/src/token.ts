import { randomBytes } from "node:crypto"

/**
 * Generates a 64-character hex bearer token — the same shape as
 * `openssl rand -hex 32`, which the manual quickstart docs recommend.
 */
export const generateToken = (): string => randomBytes(32).toString("hex")
