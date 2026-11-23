import { readFileSync } from "node:fs"
import { describe, it, expect, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import {
  closesPublicPortWithoutOrigin,
  envContentWithPublicUrl,
  gatewayApiEndpointQuery,
  resolvePublicUrl,
} from "../instance-env.js"

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

    expect(resolved).toEqual({
      url: "https://abc123.execute-api.us-east-1.amazonaws.com",
      source: "API Gateway",
    })
    expect(queryGatewayUrl).toHaveBeenCalledTimes(1)
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
      // Anchored: toThrow(string) substring-matches; the message is a
      // hardcoded literal and must match exactly.
      /^could not resolve the public URL from PUBLIC_URL, CUSTOM_DOMAIN, or the API Gateway$/,
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
      /^could not resolve the public URL from PUBLIC_URL, CUSTOM_DOMAIN, or the API Gateway$/,
    )
  })
})

describe("envContentWithPublicUrl", () => {
  it("replaces an existing PUBLIC_URL line in place", () => {
    const envFileContent =
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://old.example.com\nVAULT_NAME=My Vault\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://new.example.com",
    })

    expect(rewritten).toBe(
      "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://new.example.com\nVAULT_NAME=My Vault\n",
    )
  })

  it("fills in an empty PUBLIC_URL= line", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe("MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n")
  })

  it("appends when no PUBLIC_URL line exists", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe("MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n")
  })

  it("appends on its own line when the content lacks a trailing newline", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe("MCP_AUTH_TOKEN=fake-token\nPUBLIC_URL=https://mcp.example.com\n")
  })

  it("leaves a commented # PUBLIC_URL line alone and appends the real one", () => {
    const envFileContent = "# PUBLIC_URL=https://commented.example.com\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe(
      "# PUBLIC_URL=https://commented.example.com\nPUBLIC_URL=https://mcp.example.com\n",
    )
  })

  it("appends to empty content without a leading blank line", () => {
    const rewritten = envContentWithPublicUrl({
      envFileContent: "",
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe("PUBLIC_URL=https://mcp.example.com\n")
  })

  it("appends with CRLF endings when the file uses CRLF", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\r\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://mcp.example.com",
    })

    expect(rewritten).toBe("MCP_AUTH_TOKEN=fake-token\r\nPUBLIC_URL=https://mcp.example.com\r\n")
  })

  it("keeps CRLF line endings intact when replacing", () => {
    const envFileContent = "MCP_AUTH_TOKEN=fake-token\r\nPUBLIC_URL=https://old.example.com\r\n"

    const rewritten = envContentWithPublicUrl({
      envFileContent,
      publicUrl: "https://new.example.com",
    })

    expect(rewritten).toBe("MCP_AUTH_TOKEN=fake-token\r\nPUBLIC_URL=https://new.example.com\r\n")
  })
})

describe("gatewayApiEndpointQuery", () => {
  // The workflows embed the query with the ${SST_STAGE} shell variable where
  // dev.ts interpolates the stage — substituting that literal reproduces the
  // exact string each workflow must carry. toContain is deliberate: the
  // workflow file is the haystack; only the embedded query is under test.
  it.each(["deploy.yml", "test_deploy.yml"])(
    "matches the query %s embeds, so CI and laptop deploys resolve the same gateway",
    (workflowFile) => {
      const workflowContent = readFileSync(
        new URL(`../../.github/workflows/${workflowFile}`, import.meta.url),
        "utf8",
      )

      expect(workflowContent).toContain(gatewayApiEndpointQuery("${SST_STAGE}"))
    },
  )

  // sst.config.ts carries the chain in source (its gateway fallback is the
  // deployed API's own URL, so it embeds no JMESPath) — pin its three steps
  // as source fragments so an edit to the Lambda's derivation fails here
  // instead of shipping a silent PUBLIC_URL mismatch that 403s every request.
  it("matches the resolution chain sst.config.ts applies for the Lambda", () => {
    const sstConfigSource = readFileSync(new URL("../../sst.config.ts", import.meta.url), "utf8")

    const publicUrlClause = "if (publicUrlOverride) return $output(publicUrlOverride)"
    const customDomainClause = "if (customDomain) return $output(`https://${customDomain}`)"
    const gatewayClause = "return api.url"

    expect(sstConfigSource).toContain(publicUrlClause)
    expect(sstConfigSource).toContain(customDomainClause)
    expect(sstConfigSource).toContain(gatewayClause)

    // The order is the contract: an explicit PUBLIC_URL must win over
    // CUSTOM_DOMAIN, which must win over the gateway fallback — swapped
    // clauses would pass the existence checks while inverting precedence.
    const publicUrlClausePosition = sstConfigSource.indexOf(publicUrlClause)
    const customDomainClausePosition = sstConfigSource.indexOf(customDomainClause)
    const gatewayClausePosition = sstConfigSource.indexOf(gatewayClause)
    expect(publicUrlClausePosition).toBeLessThan(customDomainClausePosition)
    expect(customDomainClausePosition).toBeLessThan(gatewayClausePosition)
  })
})

describe("closesPublicPortWithoutOrigin", () => {
  it.each([
    { label: "BIND_ADDRESS unset", bindAddress: undefined, originUrl: undefined },
    { label: "an empty BIND_ADDRESS (an unset CI Variable)", bindAddress: "", originUrl: "" },
    {
      label: "BIND_ADDRESS=0.0.0.0 without ORIGIN_URL",
      bindAddress: "0.0.0.0",
      originUrl: undefined,
    },
    {
      label: "a loopback BIND_ADDRESS when ORIGIN_URL is set",
      bindAddress: "127.0.0.1",
      originUrl: "https://origin.example.com",
    },
  ])("allows $label", ({ bindAddress, originUrl }) => {
    expect(closesPublicPortWithoutOrigin({ bindAddress, originUrl })).toBe(false)
  })

  it.each([
    { label: "ORIGIN_URL unset", originUrl: undefined },
    { label: "an empty ORIGIN_URL (an unset CI secret)", originUrl: "" },
  ])("refuses a loopback BIND_ADDRESS with $label", ({ originUrl }) => {
    expect(closesPublicPortWithoutOrigin({ bindAddress: "127.0.0.1", originUrl })).toBe(true)
  })
})

type WorkflowStep = { name?: string; env?: Record<string, string>; run?: string }

const findDeployStep = ({
  workflowFile,
  stepName,
}: {
  workflowFile: string
  stepName: string
}): WorkflowStep => {
  const workflow: { jobs: { deploy: { steps: WorkflowStep[] } } } = parseYaml(
    readFileSync(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), "utf8"),
  )
  const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === stepName)

  if (!step) {
    throw new Error(`${workflowFile} has no "${stepName}" step`)
  }
  return step
}

describe("deploy workflows", () => {
  // sst.config.ts refuses a closed public port only with the values the step
  // passes; without BIND_ADDRESS every bind would pass in CI.
  it.each(["deploy.yml", "test_deploy.yml"])(
    "%s passes the BIND_ADDRESS Variable and the ORIGIN_URL secret to SST deploy",
    (workflowFile) => {
      const sstDeployEnv = findDeployStep({ workflowFile, stepName: "SST deploy" }).env

      expect({
        BIND_ADDRESS: sstDeployEnv?.BIND_ADDRESS,
        ORIGIN_URL: sstDeployEnv?.ORIGIN_URL,
      }).toEqual({
        BIND_ADDRESS: "${{ vars.BIND_ADDRESS }}",
        ORIGIN_URL: "${{ secrets.ORIGIN_URL }}",
      })
    },
  )

  // Each workflow writes the instance .env itself, so a setting added to only
  // one of them reaches only test deploys or only releases.
  it("write the same instance .env, apart from test_deploy.yml's image tag", () => {
    const stepName = "Write Lightsail .env from secrets"
    const releaseStep = findDeployStep({ workflowFile: "deploy.yml", stepName })
    const testStep = findDeployStep({ workflowFile: "test_deploy.yml", stepName })

    expect(testStep.env).toEqual(releaseStep.env)
    expect(testStep.run?.replace("VAULT_CORTEX_TAG=test\n", "")).toBe(releaseStep.run)
  })
})
