/**
 * Lambda authorizer for API Gateway HTTP API (payload format 2.0).
 *
 * Validates a static bearer token against the McpAuthToken SST secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Key facts:
 *   - API Gateway HTTP API v2 LOWERCASES all header names.
 *     Read `event.headers.authorization`, not `Authorization`.
 *   - Simple response format: just return { isAuthorized: boolean }.
 *   - Linked to the SST secret via `link: [mcpAuthToken]` in sst.config.ts,
 *     making `Resource.McpAuthToken.value` available at runtime.
 */

import { timingSafeEqual } from "node:crypto";
import { Resource } from "sst";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";

const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
};

const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
};

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<{ isAuthorized: boolean }> => {
  const token = parseBearer(event.headers?.authorization);

  if (!token) {
    console.warn("auth_failed: missing or malformed Authorization header");
    return { isAuthorized: false };
  }

  const expected = Resource.McpAuthToken.value;

  if (!expected || !safeEqual(token, expected)) {
    console.warn("auth_failed: token mismatch");
    return { isAuthorized: false };
  }

  return { isAuthorized: true };
};
