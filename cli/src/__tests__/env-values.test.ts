import { describe, expect, it } from "vitest"

import {
  detectMode,
  parseEnvValues,
  readEnvInstanceName,
  readEnvObsidianToken,
  readEnvPort,
  readEnvPublicUrl,
  readEnvValue,
  readEnvVaultPath,
} from "../env-values.js"

describe("readEnvValue", () => {
  it("reads the value of an active line", () => {
    expect(readEnvValue(parseEnvValues("PORT=9000\nTZ=UTC\n"), "PORT")).toBe("9000")
  })

  it("returns the last duplicate, matching docker --env-file precedence", () => {
    expect(readEnvValue(parseEnvValues("PORT=8000\nTZ=UTC\nPORT=9000\n"), "PORT")).toBe("9000")
  })

  it("returns undefined for a commented-out line", () => {
    expect(readEnvValue(parseEnvValues("# TZ=America/New_York\n"), "TZ")).toBeUndefined()
  })

  it("returns undefined for a missing line", () => {
    expect(readEnvValue(parseEnvValues("PORT=9000\n"), "TZ")).toBeUndefined()
  })

  it.each([
    { label: "double quotes", envContent: 'PORT="9000"\n' },
    { label: "single quotes", envContent: "PORT='9000'\n" },
  ])("drops one pair of surrounding $label, as the server reads the value", ({ envContent }) => {
    expect(readEnvValue(parseEnvValues(envContent), "PORT")).toBe("9000")
  })

  it("returns an empty string for a line with no value", () => {
    expect(readEnvValue(parseEnvValues("PORT=\n"), "PORT")).toBe("")
  })
})

describe("readEnvPort", () => {
  it("returns the default 8000 for an empty .env", () => {
    expect(readEnvPort(parseEnvValues(""))).toEqual({ kind: "ok", port: 8000 })
  })

  it("returns the default 8000 when PORT is only present as a comment", () => {
    expect(readEnvPort(parseEnvValues("MCP_AUTH_TOKEN=abc\n# PORT=9000\n"))).toEqual({
      kind: "ok",
      port: 8000,
    })
  })

  it("returns an uncommented PORT override", () => {
    expect(readEnvPort(parseEnvValues("MCP_AUTH_TOKEN=abc\nPORT=9000\n"))).toEqual({
      kind: "ok",
      port: 9000,
    })
  })

  it("strips surrounding double quotes from the port value", () => {
    expect(readEnvPort(parseEnvValues('MCP_AUTH_TOKEN=abc\nPORT="9000"\n'))).toEqual({
      kind: "ok",
      port: 9000,
    })
  })

  it("takes the last active PORT line, as docker --env-file does", () => {
    expect(readEnvPort(parseEnvValues("PORT=8000\nMCP_AUTH_TOKEN=abc\nPORT=8001\n"))).toEqual({
      kind: "ok",
      port: 8001,
    })
  })

  it("reads an empty last PORT line as the default port, not an earlier line's port", () => {
    expect(readEnvPort(parseEnvValues("PORT=9000\nMCP_AUTH_TOKEN=abc\nPORT=\n"))).toEqual({
      kind: "ok",
      port: 8000,
    })
  })

  it.each([
    { label: "letters", portValue: "abc", reportedValue: "abc" },
    { label: "digits then letters", portValue: "80a", reportedValue: "80a" },
    { label: "zero", portValue: "0", reportedValue: "0" },
    { label: "a number above 65535", portValue: "70000", reportedValue: "70000" },
    { label: "a quoted value padded with spaces", portValue: '" 9000 "', reportedValue: " 9000 " },
  ])(
    "reports $label as an invalid port instead of using the default",
    ({ portValue, reportedValue }) => {
      expect(readEnvPort(parseEnvValues(`PORT=9000\nPORT=${portValue}\n`))).toEqual({
        kind: "invalid",
        message: `PORT "${reportedValue}" is not a valid port — use a whole number between 1 and 65535.`,
      })
    },
  )
})

describe("readEnvInstanceName", () => {
  it("returns the default name for an empty .env", () => {
    expect(readEnvInstanceName(parseEnvValues(""))).toEqual({
      kind: "ok",
      instanceName: "vault-cortex",
    })
  })

  it.each([
    { label: "no INSTANCE_NAME line", content: "MCP_AUTH_TOKEN=abc\n" },
    { label: "a commented-out line", content: "# INSTANCE_NAME=work\n" },
    { label: "an empty value", content: "INSTANCE_NAME=\n" },
    { label: "an empty quoted value", content: 'INSTANCE_NAME=""\n' },
  ])("returns the default name for $label", ({ content }) => {
    expect(readEnvInstanceName(parseEnvValues(content))).toEqual({
      kind: "ok",
      instanceName: "vault-cortex",
    })
  })

  it.each([
    { label: "a plain name", content: "INSTANCE_NAME=work_2\n", expected: "work_2" },
    {
      label: "a double-quoted name",
      content: 'INSTANCE_NAME="work-vault"\n',
      expected: "work-vault",
    },
    {
      label: "a single-quoted name",
      content: "INSTANCE_NAME='work-vault'\n",
      expected: "work-vault",
    },
    { label: "a name with trailing spaces", content: "INSTANCE_NAME=work  \n", expected: "work" },
  ])("returns $label as written, without quotes or spaces", ({ content, expected }) => {
    expect(readEnvInstanceName(parseEnvValues(content))).toEqual({
      kind: "ok",
      instanceName: expected,
    })
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envValues = parseEnvValues("INSTANCE_NAME=vault-cortex\nPORT=8001\nINSTANCE_NAME=work\n")

    expect(readEnvInstanceName(envValues)).toEqual({ kind: "ok", instanceName: "work" })
  })

  it.each([
    { label: "a one-character name", value: "a" },
    { label: "uppercase letters", value: "Work" },
    { label: "a space", value: "my vault" },
    { label: "a leading hyphen", value: "-work" },
    { label: "a dot", value: "work.vault" },
  ])("rejects $label with the rule in the message", ({ value }) => {
    expect(readEnvInstanceName(parseEnvValues(`INSTANCE_NAME=${value}\n`))).toEqual({
      kind: "invalid",
      message: `INSTANCE_NAME "${value}" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.`,
    })
  })
})

describe("readEnvVaultPath", () => {
  it("returns undefined for an empty .env", () => {
    expect(readEnvVaultPath(parseEnvValues(""))).toBeUndefined()
  })

  it("returns undefined when VAULT_PATH is only a comment", () => {
    expect(
      readEnvVaultPath(parseEnvValues("MCP_AUTH_TOKEN=abc\n# VAULT_PATH=/vault\n")),
    ).toBeUndefined()
  })

  it("returns the vault path from an uncommented line", () => {
    expect(
      readEnvVaultPath(parseEnvValues("MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n")),
    ).toBe("/home/user/MyVault")
  })

  it("handles paths with spaces", () => {
    expect(
      readEnvVaultPath(parseEnvValues("MCP_AUTH_TOKEN=abc\nVAULT_PATH=/Users/me/My Vault\n")),
    ).toBe("/Users/me/My Vault")
  })

  it("strips surrounding double quotes from the value", () => {
    expect(
      readEnvVaultPath(parseEnvValues('MCP_AUTH_TOKEN=abc\nVAULT_PATH="/Users/me/My Vault"\n')),
    ).toBe("/Users/me/My Vault")
  })

  it("strips surrounding single quotes from the value", () => {
    expect(
      readEnvVaultPath(parseEnvValues("MCP_AUTH_TOKEN=abc\nVAULT_PATH='/Users/me/My Vault'\n")),
    ).toBe("/Users/me/My Vault")
  })

  it("returns undefined when the value is an empty pair of quotes", () => {
    expect(readEnvVaultPath(parseEnvValues('MCP_AUTH_TOKEN=abc\nVAULT_PATH=""\n'))).toBeUndefined()
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envValues = parseEnvValues(
      "VAULT_PATH=/Users/me/OldVault\nMCP_AUTH_TOKEN=abc\nVAULT_PATH=/Users/me/NewVault\n",
    )

    expect(readEnvVaultPath(envValues)).toBe("/Users/me/NewVault")
  })
})

describe("readEnvPublicUrl", () => {
  it("returns the value of an uncommented PUBLIC_URL line", () => {
    expect(
      readEnvPublicUrl(
        parseEnvValues("MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com\n"),
      ),
    ).toBe("https://vault.example.com")
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envValues = parseEnvValues(
      "PUBLIC_URL=https://old.example.com\nMCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://new.example.com\n",
    )

    expect(readEnvPublicUrl(envValues)).toBe("https://new.example.com")
  })

  it("strips trailing slashes so consumers can append paths cleanly", () => {
    // A hand-edited `https://host/` must not become `https://host//mcp` in
    // the connect message — mirror askPublicUrl's prompt-side normalization.
    expect(
      readEnvPublicUrl(
        parseEnvValues("MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com/\n"),
      ),
    ).toBe("https://vault.example.com")
  })

  it("strips a run of trailing slashes, not just one", () => {
    expect(
      readEnvPublicUrl(
        parseEnvValues("MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com///\n"),
      ),
    ).toBe("https://vault.example.com")
  })

  it("returns undefined for an empty .env", () => {
    expect(readEnvPublicUrl(parseEnvValues(""))).toBeUndefined()
  })

  it("returns undefined when PUBLIC_URL is only a comment", () => {
    expect(
      readEnvPublicUrl(parseEnvValues("MCP_AUTH_TOKEN=abc\n# PUBLIC_URL=https://x\n")),
    ).toBeUndefined()
  })

  it("returns undefined for an empty PUBLIC_URL= line", () => {
    expect(readEnvPublicUrl(parseEnvValues("MCP_AUTH_TOKEN=abc\nPUBLIC_URL=\n"))).toBeUndefined()
  })

  it("returns undefined for a whitespace-only PUBLIC_URL= line", () => {
    // The parse keeps the spaces; the trim must not leak "" past the
    // non-empty contract.
    expect(readEnvPublicUrl(parseEnvValues("MCP_AUTH_TOKEN=abc\nPUBLIC_URL=   \n"))).toBeUndefined()
  })

  it("strips surrounding double quotes from the value", () => {
    expect(
      readEnvPublicUrl(
        parseEnvValues('MCP_AUTH_TOKEN=abc\nPUBLIC_URL="https://vault.example.com"\n'),
      ),
    ).toBe("https://vault.example.com")
  })

  it("strips quotes then trailing slashes", () => {
    expect(
      readEnvPublicUrl(
        parseEnvValues('MCP_AUTH_TOKEN=abc\nPUBLIC_URL="https://vault.example.com/"\n'),
      ),
    ).toBe("https://vault.example.com")
  })

  it("returns undefined when the quotes hold only whitespace", () => {
    expect(
      readEnvPublicUrl(parseEnvValues('MCP_AUTH_TOKEN=abc\nPUBLIC_URL="   "\n')),
    ).toBeUndefined()
  })

  it("trims whitespace inside the quotes before stripping trailing slashes", () => {
    expect(
      readEnvPublicUrl(
        parseEnvValues('MCP_AUTH_TOKEN=abc\nPUBLIC_URL=" https://vault.example.com/ "\n'),
      ),
    ).toBe("https://vault.example.com")
  })
})

describe("detectMode", () => {
  it("returns local when OBSIDIAN_AUTH_TOKEN is absent", () => {
    expect(detectMode(parseEnvValues("MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n"))).toBe(
      "local",
    )
  })

  it("returns local when OBSIDIAN_AUTH_TOKEN is only a comment", () => {
    expect(detectMode(parseEnvValues("MCP_AUTH_TOKEN=abc\n# OBSIDIAN_AUTH_TOKEN=token\n"))).toBe(
      "local",
    )
  })

  it("returns remote when OBSIDIAN_AUTH_TOKEN is present and uncommented", () => {
    const envValues = parseEnvValues(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=token123\nVAULT_NAME=MyVault\n",
    )

    expect(detectMode(envValues)).toBe("remote")
  })

  it("returns remote even when OBSIDIAN_AUTH_TOKEN is empty (deferred fill-in)", () => {
    expect(detectMode(parseEnvValues("MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=\n"))).toBe("remote")
  })
})

describe("readEnvObsidianToken", () => {
  it("returns undefined for an empty .env", () => {
    expect(readEnvObsidianToken(parseEnvValues(""))).toBeUndefined()
  })

  it("returns the token value from an existing .env", () => {
    const envValues = parseEnvValues(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=my-token\nVAULT_NAME=Test\n",
    )

    expect(readEnvObsidianToken(envValues)).toBe("my-token")
  })

  it("returns undefined when the line exists but the value is empty", () => {
    const envValues = parseEnvValues("MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=\nVAULT_NAME=Test\n")

    expect(readEnvObsidianToken(envValues)).toBeUndefined()
  })

  it("returns undefined when the value is an empty pair of quotes", () => {
    const envValues = parseEnvValues('OBSIDIAN_AUTH_TOKEN=old-token\nOBSIDIAN_AUTH_TOKEN=""\n')

    expect(readEnvObsidianToken(envValues)).toBeUndefined()
  })

  it("keeps the quotes around a quoted token", () => {
    expect(readEnvObsidianToken(parseEnvValues('OBSIDIAN_AUTH_TOKEN="my-token"\n'))).toBe(
      '"my-token"',
    )
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envValues = parseEnvValues(
      "OBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=Test\nOBSIDIAN_AUTH_TOKEN=new-token\n",
    )

    expect(readEnvObsidianToken(envValues)).toBe("new-token")
  })

  it("returns undefined when the file has no OBSIDIAN_AUTH_TOKEN line", () => {
    expect(
      readEnvObsidianToken(parseEnvValues("MCP_AUTH_TOKEN=abc\nVAULT_NAME=Test\n")),
    ).toBeUndefined()
  })

  it("trims whitespace from the token value", () => {
    expect(readEnvObsidianToken(parseEnvValues("OBSIDIAN_AUTH_TOKEN=  spaced-token  \n"))).toBe(
      "spaced-token",
    )
  })
})

describe("value readers with an empty last line", () => {
  it.each([
    {
      label: "VAULT_PATH",
      envContent: "VAULT_PATH=/Users/me/OldVault\nVAULT_PATH=\n",
      readValue: readEnvVaultPath,
    },
    {
      label: "PUBLIC_URL",
      envContent: "PUBLIC_URL=https://old.example.com\nPUBLIC_URL=\n",
      readValue: readEnvPublicUrl,
    },
    {
      label: "OBSIDIAN_AUTH_TOKEN",
      envContent: "OBSIDIAN_AUTH_TOKEN=old-token\nOBSIDIAN_AUTH_TOKEN=\n",
      readValue: readEnvObsidianToken,
    },
  ])(
    "read an empty last $label line as unset, as docker --env-file does",
    ({ envContent, readValue }) => {
      expect(readValue(parseEnvValues(envContent))).toBeUndefined()
    },
  )
})
