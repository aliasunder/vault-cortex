import { describe, expect, it } from "vitest"

import { decidePort, portsOfOtherContainers } from "../ports.js"

describe("portsOfOtherContainers", () => {
  it("leaves out the install's own ports", () => {
    const portsInUse = portsOfOtherContainers(
      [
        { hostPort: 8000, containerName: "vault-cortex" },
        { hostPort: 9100, containerName: "other-app" },
      ],
      "vault-cortex",
    )

    expect(portsInUse).toEqual(new Map([[9100, "other-app"]]))
  })

  it.each([
    { label: "after", containerNames: ["vault-cortex", "stopped-test"] },
    { label: "before", containerNames: ["stopped-test", "vault-cortex"] },
  ])(
    "keeps a port another container also publishes, listed $label the install's own",
    ({ containerNames }) => {
      const publishedPorts = containerNames.map((containerName) => {
        return { hostPort: 8000, containerName }
      })

      expect(portsOfOtherContainers(publishedPorts, "vault-cortex")).toEqual(
        new Map([[8000, "stopped-test"]]),
      )
    },
  )
})

describe("decidePort", () => {
  const portsInUse = new Map([
    [8000, "other-app"],
    [9100, "work"],
  ])

  it("uses a free --port as the PORT setting", () => {
    expect(decidePort({ request: { kind: "flag", port: "9200" }, portsInUse })).toEqual({
      kind: "use",
      settings: { PORT: "9200" },
    })
  })

  it("reports a --port another container publishes as taken, naming that container", () => {
    expect(decidePort({ request: { kind: "flag", port: "9100" }, portsInUse })).toEqual({
      kind: "taken",
      port: "9100",
      containerName: "work",
    })
  })

  it("keeps the default port without a PORT setting while it is free", () => {
    expect(decidePort({ request: { kind: "default" }, portsInUse: new Map() })).toEqual({
      kind: "use",
      settings: {},
    })
  })

  it("reports the default port as taken when another container publishes it", () => {
    expect(decidePort({ request: { kind: "default" }, portsInUse })).toEqual({
      kind: "taken",
      port: "8000",
      containerName: "other-app",
    })
  })

  it("asks for an unknown port even when the default is free", () => {
    expect(decidePort({ request: { kind: "unknown" }, portsInUse: new Map() })).toEqual({
      kind: "ask",
    })
  })
})
