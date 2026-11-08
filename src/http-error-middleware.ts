import type { ErrorRequestHandler, NextFunction, Request, Response } from "express"
import { logger } from "./logger.js"
import { extractClientIp, headerAsString } from "./auth.js"
import { describeError } from "./utils/describe-error.js"
import { isHttpClientError } from "./utils/is-http-client-error.js"

/** Request-body errors get a short 4xx warning; server failures retain their stack. */
export const createErrorMiddleware = ({
  trustForwardedHops,
}: {
  trustForwardedHops: number
}): ErrorRequestHandler => {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const requestContext = {
      sessionId: headerAsString(req.headers["mcp-session-id"]),
      clientIp: extractClientIp(req, trustForwardedHops),
      method: req.method,
      path: req.path,
    }

    // Routes answer other client errors themselves, so exposed 4xx errors
    // reaching this handler can use one generic body error.
    if (isHttpClientError(err)) {
      logger.warn("request_body_rejected", {
        ...requestContext,
        type: "type" in err ? err.type : err.name,
        status: err.status,
      })
      if (!res.headersSent) res.status(err.status).json({ error: "invalid request body" })
      return
    }

    logger.error("unhandled_error", {
      ...requestContext,
      error: describeError(err),
      stack: err.stack,
    })
    if (!res.headersSent) {
      res.status(500).json({ error: "internal server error" })
    }
  }
}
