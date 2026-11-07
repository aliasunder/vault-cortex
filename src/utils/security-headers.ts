import type { NextFunction, Request, Response } from "express"

const SECURITY_HEADERS = {
  // Browsers that predate the frame-ancestors directive read only this header.
  "X-Frame-Options": "DENY",
  // The policy names only frame-ancestors, because a fuller one would block the
  // consent and setup pages' inline script and styles.
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  // Sends no referrer to other sites. no-referrer would also make the consent
  // form's post arrive with `Origin: null`, hiding which site sent it.
  "Referrer-Policy": "same-origin",
}

/** Express middleware that stops other sites from framing a response and from
 *  receiving its address as a referrer, and turns off content-type sniffing. */
export const securityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.set(SECURITY_HEADERS)
  next()
}
