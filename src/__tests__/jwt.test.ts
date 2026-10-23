import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { DateTime } from "luxon"
import { getDeploymentJwtVerification, signJwt, verifyJwt } from "../jwt.js"
import type { JwtPayload } from "../jwt.js"

const SECRET = "test-secret"
const OTHER_SECRET = "other-secret"
const ISSUER = "https://mcp.example.com/"
const AUDIENCE = "https://mcp.example.com/mcp"

const buildPayload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: "test-client",
  scope: "vault",
  exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
  iss: ISSUER,
  aud: AUDIENCE,
  ...overrides,
})

const encodeJsonSegment = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

/** Signs claims with HS256 under any header segment, so a test can vary
 *  what the header says. */
const signUnderHeader = ({
  headerSegment,
  claims,
  secret,
}: {
  headerSegment: string
  claims: object
  secret: string
}): string => {
  const body = encodeJsonSegment(claims)
  const sig = createHmac("sha256", secret)
    .update(`${headerSegment}.${body}`)
    .digest()
    .toString("base64url")
  return `${headerSegment}.${body}.${sig}`
}

/** Signs any claims object, including the malformed and audience-less
 *  ones `signJwt`'s payload type rejects. */
const signClaims = (claims: object, secret: string): string => {
  return signUnderHeader({
    headerSegment: encodeJsonSegment({ alg: "HS256", typ: "JWT" }),
    claims,
    secret,
  })
}

/** Verifies a JWT against this file's deployment binding. */
const verify = (token: string, secret: string): JwtPayload | null =>
  verifyJwt({
    token,
    secret,
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
  })

const getBoundJwtVerification = ({
  token,
  secret = SECRET,
}: {
  token: string
  secret?: string
}) => {
  return getDeploymentJwtVerification({
    token,
    secret,
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
  })
}

describe("signJwt", () => {
  it("produces a 3-part dot-separated token", () => {
    const token = signJwt(buildPayload(), SECRET)
    expect(token.split(".")).toHaveLength(3)
  })

  it("is deterministic — same payload + secret yields same token", () => {
    const payload = buildPayload()
    expect(signJwt(payload, SECRET)).toBe(signJwt(payload, SECRET))
  })

  it("uses the HS256 + JWT header", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header] = token.split(".") as [string]
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString()) as {
      alg: string
      typ: string
    }
    expect(decoded).toEqual({ alg: "HS256", typ: "JWT" })
  })

  it("encodes the payload as base64url JSON", () => {
    const payload = buildPayload({ sub: "alice", scope: "vault read" })
    const token = signJwt(payload, SECRET)
    const [, body] = token.split(".") as [string, string]
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString()) as JwtPayload
    expect(decoded).toEqual(payload)
  })
})

describe("getDeploymentJwtVerification", () => {
  it("classifies a correctly bound future token as valid", () => {
    const payload = buildPayload()
    expect(getBoundJwtVerification({ token: signJwt(payload, SECRET) })).toEqual({
      status: "valid",
      payload,
    })
  })

  it("classifies a correctly bound expired token as expired", () => {
    const payload = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
    })
    expect(getBoundJwtVerification({ token: signJwt(payload, SECRET) })).toEqual({
      status: "expired",
      payload,
    })
  })

  it("classifies an expired token signed with another secret as invalid", () => {
    const payload = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
    })
    expect(getBoundJwtVerification({ token: signJwt(payload, OTHER_SECRET) })).toEqual({
      status: "invalid",
    })
  })

  it("classifies an expired token from another issuer as invalid", () => {
    const payload = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
      iss: "https://other.example/",
    })
    expect(getBoundJwtVerification({ token: signJwt(payload, SECRET) })).toEqual({
      status: "invalid",
    })
  })

  it("classifies an expired token for another audience as invalid", () => {
    const payload = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
      aud: "https://other.example/mcp",
    })
    expect(getBoundJwtVerification({ token: signJwt(payload, SECRET) })).toEqual({
      status: "invalid",
    })
  })

  it("classifies an expired token without an audience as invalid", () => {
    const token = signClaims(
      {
        sub: "test-client",
        scope: "vault",
        exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
        iss: ISSUER,
      },
      SECRET,
    )
    expect(getBoundJwtVerification({ token })).toEqual({ status: "invalid" })
  })

  it("classifies an expired token with malformed claims as invalid", () => {
    const token = signClaims(
      {
        sub: "test-client",
        exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
        iss: ISSUER,
        aud: AUDIENCE,
      },
      SECRET,
    )
    expect(getBoundJwtVerification({ token })).toEqual({ status: "invalid" })
  })
})

describe("verifyJwt", () => {
  it("round-trips a valid payload", () => {
    const payload = buildPayload()
    const decoded = verify(signJwt(payload, SECRET), SECRET)
    expect(decoded).toEqual(payload)
  })

  it("returns null for a token signed with a different secret", () => {
    const token = signJwt(buildPayload(), SECRET)
    expect(verify(token, OTHER_SECRET)).toBeNull()
  })

  it("returns null for malformed tokens (wrong number of parts)", () => {
    expect(verify("only-one-part", SECRET)).toBeNull()
    expect(verify("two.parts", SECRET)).toBeNull()
    expect(verify("four.parts.in.token", SECRET)).toBeNull()
    expect(verify("", SECRET)).toBeNull()
  })

  it("returns null when the payload has been tampered with", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, , sig] = token.split(".") as [string, string, string]
    const tamperedBody = Buffer.from(JSON.stringify(buildPayload({ scope: "admin" }))).toString(
      "base64url",
    )
    expect(verify(`${header}.${tamperedBody}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null for an expired token (exp in the past)", () => {
    const expired = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
    })
    expect(verify(signJwt(expired, SECRET), SECRET)).toBeNull()
  })

  it("accepts a token whose exp is comfortably in the future", () => {
    const future = buildPayload({
      exp: DateTime.now().plus({ days: 1 }).toUnixInteger(),
    })
    expect(verify(signJwt(future, SECRET), SECRET)).toEqual(future)
  })

  it("returns null when the payload body is not valid JSON", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
    const garbageBody = Buffer.from("not-json").toString("base64url")
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${garbageBody}`)
      .digest()
      .toString("base64url")
    expect(verify(`${header}.${garbageBody}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null for a token whose signature differs in length", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, body] = token.split(".") as [string, string]
    expect(verify(`${header}.${body}.short`, SECRET)).toBeNull()
  })

  it("returns null for a payload missing required fields", () => {
    const token = signClaims({ foo: "bar" }, SECRET)
    expect(verify(token, SECRET)).toBeNull()
  })

  it("returns null for a payload without sub", () => {
    const token = signClaims(
      {
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: ISSUER,
        aud: AUDIENCE,
      },
      SECRET,
    )
    expect(verify(token, SECRET)).toBeNull()
  })

  it("returns null when exp is a string instead of number", () => {
    const token = signClaims(
      {
        sub: "x",
        scope: "vault",
        exp: "not-a-number",
        iss: ISSUER,
        aud: AUDIENCE,
      },
      SECRET,
    )
    expect(verify(token, SECRET)).toBeNull()
  })

  it("returns null when the issuer differs from the expected issuer", () => {
    const foreignIssuer = buildPayload({ iss: "https://other.example/" })
    expect(verify(signJwt(foreignIssuer, SECRET), SECRET)).toBeNull()
  })

  it("returns null when the audience differs from the expected audience", () => {
    // The shared-secret case: a token another deployment minted under the
    // same secret carries a valid signature and still must not verify here.
    const foreignAudience = buildPayload({ aud: "https://other.example/mcp" })
    expect(verify(signJwt(foreignAudience, SECRET), SECRET)).toBeNull()
  })

  it("returns null when the audience differs only by a trailing slash", () => {
    // Callers canonicalize before comparing; the verifier itself is exact.
    const trailingSlash = buildPayload({ aud: `${AUDIENCE}/` })
    expect(verify(signJwt(trailingSlash, SECRET), SECRET)).toBeNull()
  })

  it("returns null for a payload without an audience", () => {
    const token = signClaims(
      {
        sub: "x",
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: ISSUER,
      },
      SECRET,
    )
    expect(verify(token, SECRET)).toBeNull()
  })

  it("accepts a token without iat", () => {
    const payload = buildPayload()
    expect(payload).not.toHaveProperty("iat")
    const decoded = verify(signJwt(payload, SECRET), SECRET)
    expect(decoded).toEqual(payload)
    expect(decoded).not.toHaveProperty("iat")
  })

  it("preserves iat when present in the payload", () => {
    const iat = DateTime.now().toUnixInteger()
    const payload = buildPayload({ iat })
    const decoded = verify(signJwt(payload, SECRET), SECRET)
    expect(decoded).toEqual(payload)
    expect(decoded?.iat).toBe(iat)
  })

  it("returns null for a token with a non-number iat", () => {
    const token = signClaims(
      {
        sub: "test-client",
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: ISSUER,
        aud: AUDIENCE,
        iat: "not-a-number",
      },
      SECRET,
    )
    expect(verify(token, SECRET)).toBeNull()
  })

  it("returns null for an unsigned token whose header claims alg none", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    const body = Buffer.from(JSON.stringify(buildPayload())).toString("base64url")
    expect(verify(`${header}.${body}.`, SECRET)).toBeNull()
  })

  it.each([
    { label: "names alg none", headerSegment: encodeJsonSegment({ alg: "none", typ: "JWT" }) },
    { label: "names RS256", headerSegment: encodeJsonSegment({ alg: "RS256", typ: "JWT" }) },
    { label: "names no algorithm", headerSegment: encodeJsonSegment({ typ: "JWT" }) },
    { label: "is not JSON", headerSegment: Buffer.from("not-json").toString("base64url") },
  ])("returns null for a correctly signed token whose header $label", ({ headerSegment }) => {
    const payload = buildPayload()
    const token = signUnderHeader({ headerSegment, claims: payload, secret: SECRET })

    // The same claims under an HS256 header verify, so only the header check rejects it.
    expect(verify(signClaims(payload, SECRET), SECRET)).toEqual(payload)
    expect(verify(token, SECRET)).toBeNull()
  })

  it("returns null for a signature of correct length but wrong bytes", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, body, sig] = token.split(".") as [string, string, string]
    const flipped = Buffer.from(sig, "base64url")
    const firstByte = flipped.at(0)

    if (firstByte === undefined) {
      throw new Error("signature unexpectedly empty")
    }
    flipped[0] = firstByte ^ 0xff
    expect(verify(`${header}.${body}.${flipped.toString("base64url")}`, SECRET)).toBeNull()
  })

  it.each([
    { label: "padding appended", rewriteSignature: (signature: string) => `${signature}=` },
    {
      label: "a stray character appended",
      rewriteSignature: (signature: string) => `${signature}!`,
    },
    {
      label: "a space inserted",
      rewriteSignature: (signature: string) => `${signature.slice(0, 8)} ${signature.slice(8)}`,
    },
  ])("returns null for a valid signature re-encoded with $label", ({ rewriteSignature }) => {
    const payload = buildPayload()
    const token = signJwt(payload, SECRET)
    const signedPart = token.slice(0, token.lastIndexOf("."))
    const signature = token.slice(token.lastIndexOf(".") + 1)
    const rewrittenSignature = rewriteSignature(signature)

    // Same bytes once decoded, so only the canonical-encoding check rejects it.
    expect(Buffer.from(rewrittenSignature, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    )
    expect(verify(token, SECRET)).toEqual(payload)
    expect(verify(`${signedPart}.${rewrittenSignature}`, SECRET)).toBeNull()
  })
})
