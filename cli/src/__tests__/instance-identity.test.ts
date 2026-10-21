import { describe, expect, it } from "vitest"

import { applyInstanceIdentity } from "../instance-identity.js"

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
