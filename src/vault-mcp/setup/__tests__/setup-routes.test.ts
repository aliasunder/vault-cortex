import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import express from "express"
import { DateTime } from "luxon"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { Logger } from "../../../logger.js"
import { createSetupRoutes } from "../setup-routes.js"
import { syncTokenStore } from "../sync-token-store.js"
import { startFakeObsidianApi } from "./fake-obsidian-api.js"
import type { FakeApiRequest, FakeApiResponse } from "./fake-obsidian-api.js"

// The documented local-dev placeholder (.gitleaks.toml allowlist) — never a
// real key.
const AUTH_TOKEN = "local-dev-token"

const SIGNED_IN = {
  token: "sync-tok",
  name: "Sample User",
  email: "user@example.com",
}

type LogCall = { level: string; message: string; data: Record<string, unknown> }

const recordingLogger = (sink: LogCall[]): Logger => {
  const make = (props: Record<string, unknown>): Logger => ({
    debug: (message, data = {}) =>
      sink.push({ level: "debug", message, data: { ...props, ...data } }),
    info: (message, data = {}) =>
      sink.push({ level: "info", message, data: { ...props, ...data } }),
    warn: (message, data = {}) =>
      sink.push({ level: "warn", message, data: { ...props, ...data } }),
    error: (message, data = {}) =>
      sink.push({ level: "error", message, data: { ...props, ...data } }),
    child: (childProps) => make({ ...props, ...childProps }),
  })
  return make({})
}

/** Script the fake API per path; unhandled paths answer 404. */
type ApiScript = {
  signIn?: (request: FakeApiRequest) => FakeApiResponse
  listVaults?: (request: FakeApiRequest) => FakeApiResponse
  validateVaultKey?: (request: FakeApiRequest) => FakeApiResponse
}

// The vault password the harness sets, and the key hash Obsidian's Sync
// client derives for it with this fixture's salt at encryption version 3 —
// computed with the pinned CLI's derivation, so the fake API can accept
// exactly the hash a correct derivation produces.
const VAULT_PASSWORD = "correct horse battery"
const WRONG_VAULT_PASSWORD = "wrong horse battery"
const VAULT_SALT = "vault-salt-1"
const VAULT_KEY_HASH =
  "60aa76a8ebdc3bd3fff0670081c08bc8056407f765a1c7b0918cc7077639a398" // gitleaks:allow

const plainVault = (name: string) => ({ id: name, name, password: "srv" })
const encryptedVault = (name: string) => ({
  id: `${name}-id`,
  name,
  password: "",
  salt: VAULT_SALT,
  host: "sync-1.example.com",
  encryption_version: 3,
})

/** Obsidian's answer to `/vault/access`: accepts the fixture's hash only. */
const vaultAccessCheck = (request: FakeApiRequest): FakeApiResponse =>
  request.body.keyhash === VAULT_KEY_HASH
    ? { body: {} }
    : { body: { error: "Wrong vault key, please try again." } }

type Harness = {
  baseUrl: string
  tokenFilePath: string
  apiRequests: FakeApiRequest[]
  onSetupComplete: ReturnType<typeof vi.fn>
  logs: LogCall[]
  postForm: (
    fields: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<Response>
  openConnections: () => Promise<number>
}

const startHarness = async ({
  api = {},
  vaultPasswordSet = false,
  vaultPasswordWrong = false,
  savedLoginRejected = false,
  // Flags rather than optional values: an explicit `undefined` would take
  // the destructuring default and silently test the wrong thing.
  vaultNameUnset = false,
  publicUrlUnset = false,
}: {
  api?: ApiScript
  vaultPasswordSet?: boolean
  vaultPasswordWrong?: boolean
  savedLoginRejected?: boolean
  vaultNameUnset?: boolean
  publicUrlUnset?: boolean
} = {}): Promise<Harness> => {
  const vaultName = vaultNameUnset ? undefined : "Notes"
  const configuredVaultPassword = vaultPasswordWrong
    ? WRONG_VAULT_PASSWORD
    : VAULT_PASSWORD
  const vaultPassword = vaultPasswordSet ? configuredVaultPassword : undefined
  const publicUrl = publicUrlUnset
    ? undefined
    : new URL("https://vault.example.com")
  const fakeApi = await startFakeObsidianApi((request) => {
    if (request.path === "/user/signin" && api.signIn)
      return api.signIn(request)
    if (request.path === "/vault/list" && api.listVaults) {
      return api.listVaults(request)
    }
    if (request.path === "/vault/access" && api.validateVaultKey) {
      return api.validateVaultKey(request)
    }
    return { status: 404, body: {} }
  })
  onTestFinished(fakeApi.close)

  const dir = mkdtempSync(join(tmpdir(), "setup-routes-"))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const tokenFilePath = join(dir, "obsidian-headless", "auth_token")

  const logs: LogCall[] = []
  const onSetupComplete = vi.fn()
  const app = express()
  app.use(
    createSetupRoutes({
      authToken: AUTH_TOKEN,
      publicUrl,
      vaultName,
      vaultPassword,
      tokenFilePath,
      obsidianApiBaseUrl: fakeApi.baseUrl,
      savedLoginRejected,
      trustForwardedHops: 0,
      onSetupComplete,
      logger: recordingLogger(logs),
    }),
  )
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP address from a listening server")
  }
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    tokenFilePath,
    apiRequests: fakeApi.requests,
    onSetupComplete,
    logs,
    postForm: (fields, signal) =>
      fetch(`${baseUrl}/setup`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
        signal: signal ?? null,
      }),
    openConnections: () =>
      new Promise((resolve, reject) => {
        server.getConnections((error, count) => {
          if (error) reject(error)
          else resolve(count)
        })
      }),
  }
}

const CREDENTIALS = {
  token: AUTH_TOKEN,
  email: "user@example.com",
  password: "pw",
}

const REQUEST_ID_PATTERN = /name="request_id" value="([^"]+)"/

describe("GET /setup", () => {
  it("serves the sign-in form", async () => {
    const harness = await startHarness()

    const response = await fetch(`${harness.baseUrl}/setup`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(html).toContain('<input type="password" id="token" name="token"')
    expect(html).not.toContain("saved Obsidian login stopped working")
  })

  it("mentions the rejected saved login when the boot chain reported one", async () => {
    const harness = await startHarness({ savedLoginRejected: true })

    const html = await (await fetch(`${harness.baseUrl}/setup`)).text()

    expect(html).toContain("Your saved Obsidian login stopped working")
  })
})

describe("POST /setup — MCP token gate", () => {
  it("answers 401 with the form and never calls Obsidian when the token is wrong", async () => {
    const harness = await startHarness({
      api: { signIn: () => ({ body: SIGNED_IN }) },
    })

    const response = await harness.postForm({
      ...CREDENTIALS,
      token: "not-the-token",
    })
    const html = await response.text()

    expect(response.status).toBe(401)
    expect(html).toContain("That MCP token does not match this server.")
    expect(harness.apiRequests).toEqual([])
    expect(existsSync(harness.tokenFilePath)).toBe(false)
    expect(harness.logs.map((call) => [call.level, call.message])).toEqual([
      ["warn", "setup_bad_token"],
    ])
  })

  it("accepts a token copied with wrapped whitespace", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [plainVault("Notes")] } }),
      },
    })

    const response = await harness.postForm({
      ...CREDENTIALS,
      token: ` local-\ndev-token `,
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("<h1>Setup complete</h1>")
  })

  it("answers 400 when the email or password is missing", async () => {
    const harness = await startHarness()

    const response = await harness.postForm({ token: AUTH_TOKEN, email: "" })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(
      "Enter your Obsidian account email and password.",
    )
    expect(harness.apiRequests).toEqual([])
  })

  it("answers 429 on the sixth attempt within a minute", async () => {
    const harness = await startHarness()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await harness.postForm({
        ...CREDENTIALS,
        token: "wrong",
      })
      await response.text()
      statuses.push(response.status)
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect(harness.logs.at(-1)?.message).toBe("setup_rate_limited")
  })
})

describe("POST /setup — sign-in outcomes", () => {
  it("writes the token 0600, shows the completion page, then signals completion", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [plainVault("Notes")] } }),
      },
    })

    const response = await harness.postForm(CREDENTIALS)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("Signed in as <strong>user@example.com</strong>.")
    expect(html).toContain(
      'Connect your MCP client to <a href="https://vault.example.com/mcp"><code>https://vault.example.com/mcp</code></a>',
    )
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
    expect((await stat(harness.tokenFilePath)).mode & 0o777).toBe(0o600)
    await vi.waitFor(() =>
      expect(harness.onSetupComplete).toHaveBeenCalledTimes(1),
    )
    expect(harness.apiRequests.map((request) => request.path)).toEqual([
      "/user/signin",
      "/vault/list",
    ])
    expect(harness.apiRequests[0]?.body).toEqual({
      email: "user@example.com",
      password: "pw",
      mfa: "",
    })
  })

  it("signals completion even when the browser disconnects while the token is written", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [plainVault("Notes")] } }),
      },
    })
    const writeSyncToken = syncTokenStore.writeSyncToken
    const abortController = new AbortController()
    // Hold the token write until the browser's connection is gone, so the
    // completion page can only ever be sent to a closed connection.
    const writeSpy = vi
      .spyOn(syncTokenStore, "writeSyncToken")
      .mockImplementation(async (params, logger) => {
        abortController.abort()
        await vi.waitFor(async () =>
          expect(await harness.openConnections()).toBe(0),
        )
        return writeSyncToken(params, logger)
      })
    onTestFinished(() => writeSpy.mockRestore())

    await expect(
      harness.postForm(CREDENTIALS, abortController.signal),
    ).rejects.toThrow("This operation was aborted")

    await vi.waitFor(() =>
      expect(harness.onSetupComplete).toHaveBeenCalledTimes(1),
    )
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
  })

  it("shows the API's error and writes nothing when the password is rejected", async () => {
    const harness = await startHarness({
      api: { signIn: () => ({ body: { error: "Invalid email or password" } }) },
    })

    const response = await harness.postForm(CREDENTIALS)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<div class="error">Invalid email or password</div>')
    expect(existsSync(harness.tokenFilePath)).toBe(false)
    expect(harness.onSetupComplete).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)).toEqual({
      level: "warn",
      message: "setup_signin_failed",
      data: {
        component: "setup-routes",
        clientIp: "127.0.0.1",
        error: "Invalid email or password",
      },
    })
  })

  it("never logs the email or password", async () => {
    const harness = await startHarness({
      api: { signIn: () => ({ body: { error: "Invalid email or password" } }) },
    })

    await (await harness.postForm(CREDENTIALS)).text()

    const logged = JSON.stringify(harness.logs)
    expect(logged).not.toContain("user@example.com")
    expect(logged).not.toContain('"pw"')
  })

  it("reports an unreachable API as a reachability problem, not a stack trace", async () => {
    const harness = await startHarness({
      api: { signIn: () => ({ status: 502, body: {} }) },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain(
      `<div class="error">Could not reach Obsidian's servers (Obsidian API answered HTTP 502).</div>`,
    )
  })
})

describe("POST /setup — two-factor round trip", () => {
  const mfaApi = (): ApiScript => ({
    signIn: (request) => {
      if (request.body.mfa === "")
        return { body: { error: "2FA code required" } }
      if (request.body.mfa !== "123456") {
        return { body: { error: "2FA code is incorrect" } }
      }
      return { body: SIGNED_IN }
    },
    listVaults: () => ({ body: { vaults: [plainVault("Notes")] } }),
  })

  it("asks for the code, then completes with it — the password is never echoed", async () => {
    const harness = await startHarness({ api: mfaApi() })

    const firstResponse = await harness.postForm(CREDENTIALS)
    const mfaHtml = await firstResponse.text()
    const requestId = REQUEST_ID_PATTERN.exec(mfaHtml)?.[1]
    if (!requestId) throw new Error("no request_id in the MFA page")
    expect(mfaHtml).not.toContain("pw")
    expect(mfaHtml).not.toContain("user@example.com")

    const secondResponse = await harness.postForm({
      request_id: requestId,
      mfa: "123456",
    })
    const completeHtml = await secondResponse.text()

    expect(secondResponse.status).toBe(200)
    expect(completeHtml).toContain("<h1>Setup complete</h1>")
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
    expect(
      harness.apiRequests
        .filter((request) => request.path === "/user/signin")
        .map((request) => request.body.mfa),
    ).toEqual(["", "123456"])
  })

  it("re-asks for the code with a fresh id when it is wrong, retiring the old id", async () => {
    const harness = await startHarness({ api: mfaApi() })
    const firstId = REQUEST_ID_PATTERN.exec(
      await (await harness.postForm(CREDENTIALS)).text(),
    )?.[1]
    if (!firstId) throw new Error("no request_id in the MFA page")

    const retryHtml = await (
      await harness.postForm({ request_id: firstId, mfa: "000000" })
    ).text()
    const secondId = REQUEST_ID_PATTERN.exec(retryHtml)?.[1]

    expect(retryHtml).toContain(
      '<div class="error">2FA code is incorrect</div>',
    )
    if (!secondId) throw new Error("no request_id in the retry page")
    expect(secondId).not.toBe(firstId)
    // The retired id no longer holds a sign-in.
    const reusedHtml = await (
      await harness.postForm({ request_id: firstId, mfa: "123456" })
    ).text()
    expect(reusedHtml).toContain("That sign-in expired — start again.")
    expect(existsSync(harness.tokenFilePath)).toBe(false)
  })

  it("expires a pending sign-in after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const harness = await startHarness({ api: mfaApi() })
    const requestId = REQUEST_ID_PATTERN.exec(
      await (await harness.postForm(CREDENTIALS)).text(),
    )?.[1]
    if (!requestId) throw new Error("no request_id in the MFA page")

    vi.setSystemTime(DateTime.now().plus({ minutes: 5, seconds: 1 }).toJSDate())
    const html = await (
      await harness.postForm({ request_id: requestId, mfa: "123456" })
    ).text()

    expect(html).toContain("That sign-in expired — start again.")
    expect(
      harness.apiRequests.filter((request) => request.path === "/user/signin"),
    ).toHaveLength(1)
  })
})

describe("POST /setup — vault pre-flight", () => {
  it("blocks with the account's vault names when VAULT_NAME matches none", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({
          body: { vaults: [plainVault("Work")], shared: [plainVault("Team")] },
        }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("There is no vault named <code>Notes</code>")
    expect(html).toContain(
      "<li><code>Work</code></li><li><code>Team</code></li>",
    )
    expect(existsSync(harness.tokenFilePath)).toBe(false)
    expect(harness.onSetupComplete).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)).toEqual({
      level: "warn",
      message: "setup_blocked",
      data: {
        component: "setup-routes",
        clientIp: "127.0.0.1",
        problem: "vault-not-found",
      },
    })
  })

  it("blocks for an encrypted vault when VAULT_PASSWORD is unset", async () => {
    const harness = await startHarness({
      vaultPasswordSet: false,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [encryptedVault("Notes")] } }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<code>VAULT_PASSWORD</code> is not set")
    expect(existsSync(harness.tokenFilePath)).toBe(false)
  })

  it("completes for an encrypted vault when Obsidian accepts the key derived from VAULT_PASSWORD", async () => {
    const harness = await startHarness({
      vaultPasswordSet: true,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [encryptedVault("Notes")] } }),
        validateVaultKey: vaultAccessCheck,
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<h1>Setup complete</h1>")
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
    expect(harness.apiRequests.map((request) => request.path)).toEqual([
      "/user/signin",
      "/vault/list",
      "/vault/access",
    ])
    expect(harness.apiRequests[2]?.body).toEqual({
      token: "sync-tok",
      vault_uid: "Notes-id",
      keyhash: VAULT_KEY_HASH,
      host: "sync-1.example.com",
      encryption_version: 3,
    })
  })

  it("blocks with Obsidian's own text when the vault rejects the key derived from VAULT_PASSWORD", async () => {
    const harness = await startHarness({
      vaultPasswordSet: true,
      vaultPasswordWrong: true,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [encryptedVault("Notes")] } }),
        validateVaultKey: vaultAccessCheck,
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain(
      "Obsidian did not accept <code>VAULT_PASSWORD</code> for the vault <code>Notes</code>: Wrong vault key, please try again.",
    )
    expect(existsSync(harness.tokenFilePath)).toBe(false)
    expect(harness.onSetupComplete).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)).toEqual({
      level: "warn",
      message: "setup_blocked",
      data: {
        component: "setup-routes",
        clientIp: "127.0.0.1",
        problem: "vault-access-rejected",
      },
    })
    const logged = JSON.stringify(harness.logs)
    expect(logged).not.toContain(WRONG_VAULT_PASSWORD)
    expect(logged).not.toContain(VAULT_SALT)
    expect(logged).not.toContain("keyhash")
    expect(html).not.toContain(WRONG_VAULT_PASSWORD)
  })

  it("completes anyway when the key check cannot reach Obsidian", async () => {
    const harness = await startHarness({
      vaultPasswordSet: true,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [encryptedVault("Notes")] } }),
        validateVaultKey: () => ({ status: 503, body: {} }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<h1>Setup complete</h1>")
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
    expect(
      harness.logs.filter(
        (call) => call.message === "setup_vault_key_check_skipped",
      ),
    ).toEqual([
      {
        level: "warn",
        message: "setup_vault_key_check_skipped",
        data: {
          component: "setup-routes",
          clientIp: "127.0.0.1",
          reason:
            "Could not reach Obsidian's servers (Obsidian API answered HTTP 503).",
        },
      },
    ])
  })

  it("completes anyway when the listing entry lacks the key material", async () => {
    const { host: _host, ...vaultWithoutHost } = encryptedVault("Notes")
    const harness = await startHarness({
      vaultPasswordSet: true,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [vaultWithoutHost] } }),
        validateVaultKey: vaultAccessCheck,
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<h1>Setup complete</h1>")
    expect(harness.apiRequests.map((request) => request.path)).toEqual([
      "/user/signin",
      "/vault/list",
    ])
    expect(
      harness.logs.filter(
        (call) => call.message === "setup_vault_key_check_skipped",
      ),
    ).toEqual([
      {
        level: "warn",
        message: "setup_vault_key_check_skipped",
        data: {
          component: "setup-routes",
          clientIp: "127.0.0.1",
          reason: "listing entry lacks the key material",
        },
      },
    ])
  })

  it("blocks when two vaults share VAULT_NAME", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({
          body: { vaults: [plainVault("Notes"), plainVault("Notes")] },
        }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("more than one vault named <code>Notes</code>")
    expect(existsSync(harness.tokenFilePath)).toBe(false)
  })

  it("blocks without calling the listing when VAULT_NAME is unset", async () => {
    const harness = await startHarness({
      vaultNameUnset: true,
      api: { signIn: () => ({ body: SIGNED_IN }) },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<code>VAULT_NAME</code> is not set")
    expect(harness.apiRequests.map((request) => request.path)).toEqual([
      "/user/signin",
    ])
    expect(existsSync(harness.tokenFilePath)).toBe(false)
  })

  it("completes anyway when the vault listing cannot be fetched", async () => {
    const harness = await startHarness({
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ status: 500, body: {} }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain("<h1>Setup complete</h1>")
    expect(await readFile(harness.tokenFilePath, "utf8")).toBe("sync-tok")
    expect(harness.logs.map((call) => call.message)).toContain(
      "setup_vault_check_skipped",
    )
  })

  it("omits the MCP URL from the completion page without a public URL", async () => {
    const harness = await startHarness({
      publicUrlUnset: true,
      api: {
        signIn: () => ({ body: SIGNED_IN }),
        listVaults: () => ({ body: { vaults: [plainVault("Notes")] } }),
      },
    })

    const html = await (await harness.postForm(CREDENTIALS)).text()

    expect(html).toContain(
      "Connect your MCP client to this server's <code>/mcp</code> address",
    )
  })
})
