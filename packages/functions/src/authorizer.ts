/**
 * Lambda authorizer for API Gateway HTTP API (payload format 2.0).
 *
 * Validates a static bearer token against the McpAuthToken SST secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Key facts:
 *   - API Gateway HTTP API v2 LOWERCASES all header names.
 *     Read `event.headers.authorization`, not `Authorization`.
 *   - Simple response format: return { isAuthorized: boolean }.
 *   - Linked to SST secret via `link: [mcpAuthToken]` in sst.config.ts,
 *     making `Resource.McpAuthToken.value` available at runtime.
 */

import { timingSafeEqual } from "node:crypto";
import { Resource } from "sst";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<{ isAuthorized: boolean }> => {
  const authHeader = event.headers?.authorization;

  if (!authHeader) {
    console.warn("auth_failed: missing Authorization header");
    return { isAuthorized: false };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    console.warn("auth_failed: malformed Bearer token");
    return { isAuthorized: false };
  }

  const token = match[1].trim();
  const expected = Resource.McpAuthToken.value;

  if (!expected || !safeEqual(token, expected)) {
    console.warn("auth_failed: token mismatch");
    return { isAuthorized: false };
  }

  return { isAuthorized: true };
};
