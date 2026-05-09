/** Shared bearer-token auth utilities — used by both the Lambda authorizer and Express middleware. */

import { timingSafeEqual } from "node:crypto"
import type { Request, Response, NextFunction } from "express"
import { logger } from "./logger.js"

/** Constant-time string comparison. Compares against itself on length mismatch to avoid timing leaks. */
export const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf) // burn the same CPU time to prevent length-based timing leaks
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

/** Extracts the token from an `Authorization: Bearer <token>` header. Case-insensitive prefix. */
export const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/** Express middleware that validates a Bearer token. Rejects with 401 on failure. Never logs the token value. */
export const createBearerMiddleware = (
  expectedToken: string,
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const clientIp = req.ip
    const token = parseBearer(req.headers.authorization)
    if (!token) {
      logger.warn("auth_failed: missing or malformed Authorization header", {
        sessionId,
        clientIp,
      })
      res.status(401).json({ error: "missing or malformed Authorization" })
      return
    }
    if (!safeEqual(token, expectedToken)) {
      logger.error("auth_failed: token mismatch", { sessionId, clientIp })
      res.status(401).json({ error: "invalid token" })
      return
    }
    next()
  }
}
