import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { DateTime } from "luxon"
import { signJwt, verifyJwt } from "../jwt.js"
import type { JwtPayload } from "../jwt.js"

const SECRET = "test-secret"
const OTHER_SECRET = "other-secret"

const buildPayload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: "test-client",
  scope: "vault",
  exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
  iss: "vault-cortex",
  ...overrides,
})

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
    const decoded = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as JwtPayload
    expect(decoded).toEqual(payload)
  })
})

describe("verifyJwt", () => {
  it("round-trips a valid payload", () => {
    const payload = buildPayload()
    const decoded = verifyJwt(signJwt(payload, SECRET), SECRET)
    expect(decoded).toEqual(payload)
  })

  it("returns null for a token signed with a different secret", () => {
    const token = signJwt(buildPayload(), SECRET)
    expect(verifyJwt(token, OTHER_SECRET)).toBeNull()
  })

  it("returns null for malformed tokens (wrong number of parts)", () => {
    expect(verifyJwt("only-one-part", SECRET)).toBeNull()
    expect(verifyJwt("two.parts", SECRET)).toBeNull()
    expect(verifyJwt("four.parts.in.token", SECRET)).toBeNull()
    expect(verifyJwt("", SECRET)).toBeNull()
  })

  it("returns null when the payload has been tampered with", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, , sig] = token.split(".") as [string, string, string]
    const tamperedBody = Buffer.from(
      JSON.stringify(buildPayload({ scope: "admin" })),
    ).toString("base64url")
    expect(verifyJwt(`${header}.${tamperedBody}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null for an expired token (exp in the past)", () => {
    const expired = buildPayload({
      exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
    })
    expect(verifyJwt(signJwt(expired, SECRET), SECRET)).toBeNull()
  })

  it("accepts a token whose exp is comfortably in the future", () => {
    const future = buildPayload({
      exp: DateTime.now().plus({ days: 1 }).toUnixInteger(),
    })
    expect(verifyJwt(signJwt(future, SECRET), SECRET)).toEqual(future)
  })

  it("returns null when the payload body is not valid JSON", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url")
    const garbageBody = Buffer.from("not-json").toString("base64url")
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${garbageBody}`)
      .digest()
      .toString("base64url")
    expect(verifyJwt(`${header}.${garbageBody}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null for a token whose signature differs in length", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, body] = token.split(".") as [string, string]
    expect(verifyJwt(`${header}.${body}.short`, SECRET)).toBeNull()
  })

  it("returns null for a payload missing required fields", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url")
    const body = Buffer.from(JSON.stringify({ foo: "bar" })).toString(
      "base64url",
    )
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${body}`)
      .digest()
      .toString("base64url")
    expect(verifyJwt(`${header}.${body}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null when exp is a string instead of number", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url")
    const body = Buffer.from(
      JSON.stringify({
        sub: "x",
        scope: "vault",
        exp: "not-a-number",
        iss: "vault-cortex",
      }),
    ).toString("base64url")
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${body}`)
      .digest()
      .toString("base64url")
    expect(verifyJwt(`${header}.${body}.${sig}`, SECRET)).toBeNull()
  })

  it("returns null for a signature of correct length but wrong bytes", () => {
    const token = signJwt(buildPayload(), SECRET)
    const [header, body, sig] = token.split(".") as [string, string, string]
    const flipped = Buffer.from(sig, "base64url")
    flipped[0] = flipped[0]! ^ 0xff
    expect(
      verifyJwt(`${header}.${body}.${flipped.toString("base64url")}`, SECRET),
    ).toBeNull()
  })
})
