import type { NextFunction, Request, Response } from "express"

const SECURITY_HEADERS = {
  // Browsers that predate the frame-ancestors directive read only this header.
  "X-Frame-Options": "DENY",
  // frame-ancestors alone: a fuller policy would block the pages' inline script and styles.
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  // Sends no referrer to other sites. no-referrer would also turn a page's own
  // form posts into `Origin: null`.
  "Referrer-Policy": "same-origin",
}

/** Express middleware that stops other sites from framing a response and from
 *  receiving its address as a referrer, and turns off content-type sniffing. */
export const securityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.set(SECURITY_HEADERS)
  next()
}
