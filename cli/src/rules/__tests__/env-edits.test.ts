import { describe, expect, it } from "vitest"

import {
  applyInstanceIdentity,
  applyOptionalSettings,
  describeStrandedPublicUrl,
  withPublicUrlOverride,
} from "../env-edits.js"

describe("applyOptionalSettings", () => {
  it("replaces the value of an active line", () => {
    const patched = applyOptionalSettings("A=1\nMEMORY_ENABLED=true\nB=2\n", {
      MEMORY_ENABLED: "false",
    })
    expect(patched).toBe("A=1\nMEMORY_ENABLED=false\nB=2\n")
  })

  it("uncomments and sets a commented-out line", () => {
    const patched = applyOptionalSettings("A=1\n# TZ=America/New_York\nB=2\n", {
      TZ: "Europe/London",
    })
    expect(patched).toBe("A=1\nTZ=Europe/London\nB=2\n")
  })

  it("appends a var that has no line at all", () => {
    const patched = applyOptionalSettings("MCP_AUTH_TOKEN=abc\n", {
      SYNC_MODE: "pull-only",
    })
    expect(patched).toBe("MCP_AUTH_TOKEN=abc\n\nSYNC_MODE=pull-only\n")
  })

  it("returns the content unchanged for empty overrides", () => {
    const content = "A=1\nB=2\n"
    expect(applyOptionalSettings(content, {})).toBe(content)
  })

  it("applies multiple overrides in one pass", () => {
    const patched = applyOptionalSettings(
      "MEMORY_ENABLED=true\nPORT=8000\n# TZ=America/New_York\n",
      {
        MEMORY_ENABLED: "false",
        PORT: "9000",
        TZ: "America/Toronto",
      },
    )
    expect(patched).toBe("MEMORY_ENABLED=false\nPORT=9000\nTZ=America/Toronto\n")
  })

  it("replaces every duplicate active line, not just the first", () => {
    // docker --env-file gives the LAST duplicate precedence — a first-line
    // replace would leave a stale duplicate silently winning.
    const patched = applyOptionalSettings("MEMORY_ENABLED=true\nPORT=8000\nMEMORY_ENABLED=true\n", {
      MEMORY_ENABLED: "false",
    })
    expect(patched).toBe("MEMORY_ENABLED=false\nPORT=8000\nMEMORY_ENABLED=false\n")
  })

  it("writes values containing replacement patterns literally", () => {
    // String.prototype.replace interprets $-patterns in string replacements;
    // the function replacement must keep the value byte-for-byte.
    const patched = applyOptionalSettings("TZ=UTC\n", { TZ: "A$&B" })
    expect(patched).toBe("TZ=A$&B\n")
  })
})

describe("withPublicUrlOverride", () => {
  it("follows a PORT change when PUBLIC_URL is the derived localhost form", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9000" },
      envContent: "PUBLIC_URL=http://localhost:8000\nPORT=8000\n",
    })
    expect(overrides).toEqual({
      PORT: "9000",
      PUBLIC_URL: "http://localhost:9000",
    })
  })

  it("follows the current PORT, not the default", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9200" },
      envContent: "PUBLIC_URL=http://localhost:9100\nPORT=9100\n",
    })
    expect(overrides).toEqual({
      PORT: "9200",
      PUBLIC_URL: "http://localhost:9200",
    })
  })

  it("reads an empty PORT line as the default port", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9000" },
      envContent: "PUBLIC_URL=http://localhost:8000\nPORT=\n",
    })
    expect(overrides).toEqual({
      PORT: "9000",
      PUBLIC_URL: "http://localhost:9000",
    })
  })

  it("follows a PORT change from a value that isn't a port when PUBLIC_URL is on the default port", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9000" },
      envContent: "PUBLIC_URL=http://localhost:8000\nPORT=80a0\n",
    })
    expect(overrides).toEqual({
      PORT: "9000",
      PUBLIC_URL: "http://localhost:9000",
    })
  })

  it("leaves a default-port PUBLIC_URL beside a valid PORT on another port", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9200" },
      envContent: "PUBLIC_URL=http://localhost:8000\nPORT=9100\n",
    })
    expect(overrides).toEqual({ PORT: "9200" })
  })

  it("never touches a custom PUBLIC_URL", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9000" },
      envContent: "PUBLIC_URL=https://vault.example.com\nPORT=8000\n",
    })
    expect(overrides).toEqual({ PORT: "9000" })
  })

  it("returns the overrides unchanged without a PORT override", () => {
    const overrides = withPublicUrlOverride({
      overrides: { MEMORY_ENABLED: "false" },
      envContent: "PUBLIC_URL=http://localhost:8000\nPORT=8000\n",
    })
    expect(overrides).toEqual({ MEMORY_ENABLED: "false" })
  })

  it("returns the overrides unchanged when PUBLIC_URL is absent", () => {
    const overrides = withPublicUrlOverride({
      overrides: { PORT: "9000" },
      envContent: "PORT=8000\n",
    })
    expect(overrides).toEqual({ PORT: "9000" })
  })
})

describe("describeStrandedPublicUrl", () => {
  const CUSTOM_URL_ENV = "PUBLIC_URL=https://vault.example.com\nPORT=8000\n"

  it("warns when a new PORT leaves a custom PUBLIC_URL as it was", () => {
    const warning = describeStrandedPublicUrl({
      envContent: CUSTOM_URL_ENV,
      pickedOverrides: { PORT: "9000" },
      appliedOverrides: { PORT: "9000" },
    })

    expect(warning).toBe(
      "PORT changed — make sure PUBLIC_URL (https://vault.example.com) still reaches the server.",
    )
  })

  it.each([
    { label: "the current port", envContent: CUSTOM_URL_ENV },
    {
      label: "the default port behind an empty PORT line",
      envContent: "PUBLIC_URL=https://vault.example.com\nPORT=\n",
    },
  ])("stays quiet when the picked PORT is $label", ({ envContent }) => {
    const warning = describeStrandedPublicUrl({
      envContent,
      pickedOverrides: { PORT: "8000" },
      appliedOverrides: { PORT: "8000" },
    })

    expect(warning).toBeUndefined()
  })

  it("stays quiet when the localhost PUBLIC_URL already names the new port", () => {
    const warning = describeStrandedPublicUrl({
      envContent: "PUBLIC_URL=http://localhost:9000\nPORT=8000\n",
      pickedOverrides: { PORT: "9000" },
      appliedOverrides: { PORT: "9000" },
    })

    expect(warning).toBeUndefined()
  })
})

const GENERATED_LOCAL_ENV =
  "MCP_AUTH_TOKEN=new\nVAULT_PATH=/vault\nPUBLIC_URL=http://localhost:8000\nPORT=8000\nINSTANCE_NAME=vault-cortex\n"

describe("applyInstanceIdentity", () => {
  it("writes carried values verbatim, keeping a custom PUBLIC_URL beside a carried port", () => {
    const envContent = applyInstanceIdentity(GENERATED_LOCAL_ENV, {
      carried: {
        INSTANCE_NAME: "work",
        PORT: "8001",
        PUBLIC_URL: "https://work.example.com",
      },
      chosen: {},
    })

    expect(envContent).toBe(
      "MCP_AUTH_TOKEN=new\nVAULT_PATH=/vault\nPUBLIC_URL=https://work.example.com\nPORT=8001\nINSTANCE_NAME=work\n",
    )
  })

  it("moves the generated localhost PUBLIC_URL to a chosen port", () => {
    const envContent = applyInstanceIdentity(GENERATED_LOCAL_ENV, {
      carried: {},
      chosen: { INSTANCE_NAME: "work", PORT: "8001" },
    })

    expect(envContent).toBe(
      "MCP_AUTH_TOKEN=new\nVAULT_PATH=/vault\nPUBLIC_URL=http://localhost:8001\nPORT=8001\nINSTANCE_NAME=work\n",
    )
  })

  it("lets a chosen value win over a carried one", () => {
    const envContent = applyInstanceIdentity(GENERATED_LOCAL_ENV, {
      carried: { INSTANCE_NAME: "old-name", PORT: "8001", PUBLIC_URL: "http://localhost:8001" },
      chosen: { PORT: "8002" },
    })

    expect(envContent).toBe(
      "MCP_AUTH_TOKEN=new\nVAULT_PATH=/vault\nPUBLIC_URL=http://localhost:8002\nPORT=8002\nINSTANCE_NAME=old-name\n",
    )
  })
})
