import { describe, it, expect, vi } from "vitest"
import { envContentWithPublicUrl, resolvePublicUrl } from "../instance-env.js"

describe("resolvePublicUrl", () => {
  it("returns an explicit PUBLIC_URL without querying the gateway", () => {
    const queryGatewayUrl = vi.fn()

    const resolved = resolvePublicUrl({
      publicUrl: "https://pinned.example.com",
      customDomain: "mcp.example.com",
      queryGatewayUrl,
    })

    expect(resolved).toEqual({
      url: "https://pinned.example.com",
      source: "PUBLIC_URL",
    })
    expect(queryGatewayUrl).toHaveBeenCalledTimes(0)
  })

  it("derives https://<CUSTOM_DOMAIN> when PUBLIC_URL is unset", () => {
    const queryGatewayUrl = vi.fn()

    const resolved = resolvePublicUrl({
      publicUrl: undefined,
      customDomain: "mcp.example.com",
      queryGatewayUrl,
    })

    expect(resolved).toEqual({
      url: "https://mcp.example.com",
      source: "CUSTOM_DOMAIN",
    })
    expect(queryGatewayUrl).toHaveBeenCalledTimes(0)
  })

  it("treats an empty PUBLIC_URL as unset and falls through to CUSTOM_DOMAIN", () => {
    const resolved = resolvePublicUrl({
      publicUrl: "",
      customDomain: "mcp.example.com",
      queryGatewayUrl: vi.fn(),
    })

    expect(resolved).toEqual({
      url: "https://mcp.example.com",
      source: "CUSTOM_DOMAIN",
    })
  })

  it("queries the gateway when neither PUBLIC_URL nor CUSTOM_DOMAIN is set", () => {
    const queryGatewayUrl = vi
      .fn()
      .mockReturnValue("https://abc123.execute-api.us-east-1.amazonaws.com")

    const resolved = resolvePublicUrl({
      publicUrl: undefined,
      customDomain: undefined,
      queryGatewayUrl,
    })

    expect(resolved).toEqual({
      url: "https://abc123.execute-api.us-east-1.amazonaws.com",
      source: "API Gateway",
    })
    expect(queryGatewayUrl).toHaveBeenCalledTimes(1)
  })

  it("treats an empty CUSTOM_DOMAIN as unset and falls through to the gateway", () => {
    const queryGatewayUrl = vi
      .fn()
      .mockReturnValue("https://abc123.execute-api.us-east-1.amazonaws.com")

    const resolved = resolvePublicUrl({
      publicUrl: undefined,
      customDomain: "",
      queryGatewayUrl,
    })

    expect(resolved.source).toBe("API Gateway")
  })

  it("throws when the gateway query returns the aws CLI's literal None", () => {
    const queryGatewayUrl = vi.fn().mockReturnValue("None")

    expect(() => {
      resolvePublicUrl({
        publicUrl: undefined,
        customDomain: undefined,
        queryGatewayUrl,
      })
    }).toThrow(
      "could not resolve the public URL from PUBLIC_URL, CUSTOM_DOMAIN, or the API Gateway",
    )
  })

  it("throws when the gateway query returns an empty string", () => {
    const queryGatewayUrl = vi.fn().mockReturnValue("")

    expect(() => {
      resolvePublicUrl({
        publicUrl: undefined,
        customDomain: undefined,
        queryGatewayUrl,
      })
    }).toThrow(
      "could not resolve the public URL from PUBLIC_URL, CUSTOM_DOMAIN, or the API Gateway",
    )
  })
})

describe("envContentWithPublicUrl", () => {
  it("replaces an existing PUBLIC_URL line in place", () => {
    const envFileContent =
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://old.example.com\nVAULT_NAME=My Vault\n"

    const rewritten = envContentWithPublicUrl(
      envFileContent,
      "https://new.example.com",
    )

    expect(rewritten).toBe(
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://new.example.com\nVAULT_NAME=My Vault\n",
    )
  })

  it("fills in an empty PUBLIC_URL= line", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=\n"

    const rewritten = envContentWithPublicUrl(
      envFileContent,
      "https://mcp.example.com",
    )

    expect(rewritten).toBe(
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n",
    )
  })

  it("appends when no PUBLIC_URL line exists", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\n"

    const rewritten = envContentWithPublicUrl(
      envFileContent,
      "https://mcp.example.com",
    )

    expect(rewritten).toBe(
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n",
    )
  })

  it("appends on its own line when the content lacks a trailing newline", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token"

    const rewritten = envContentWithPublicUrl(
      envFileContent,
      "https://mcp.example.com",
    )

    expect(rewritten).toBe(
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n",
    )
  })

  it("leaves a commented # PUBLIC_URL line alone and appends the real one", () => {
    const envFileContent = "# PUBLIC_URL=https://commented.example.com\n"

    const rewritten = envContentWithPublicUrl(
      envFileContent,
      "https://mcp.example.com",
    )

    expect(rewritten).toBe(
      "# PUBLIC_URL=https://commented.example.com\nPUBLIC_URL=https://mcp.example.com\n",
    )
  })

  it("appends to empty content without a leading blank line", () => {
    const rewritten = envContentWithPublicUrl("", "https://mcp.example.com")

    expect(rewritten).toBe("PUBLIC_URL=https://mcp.example.com\n")
  })
})
