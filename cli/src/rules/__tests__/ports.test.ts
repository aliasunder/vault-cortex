import { describe, expect, it } from "vitest"

import {
  buildPortsInUse,
  decidePort,
  isValidPort,
  portsOfOtherContainers,
  suggestFreePort,
} from "../ports.js"

describe("isValidPort", () => {
  it.each([
    { label: "the lowest port", value: "1" },
    { label: "the highest port", value: "65535" },
    { label: "the default port", value: "8000" },
  ])("accepts $label", ({ value }) => {
    expect(isValidPort(value)).toBe(true)
  })

  it.each([
    { label: "zero", value: "0" },
    { label: "a number above 65535", value: "65536" },
    { label: "exponent notation", value: "1e4" },
    { label: "a hex number", value: "0x1F40" },
    { label: "a signed number", value: "+9000" },
    { label: "an empty value", value: "" },
    { label: "a leading zero", value: "08000" },
  ])("rejects $label", ({ value }) => {
    expect(isValidPort(value)).toBe(false)
  })
})

describe("suggestFreePort", () => {
  it("suggests the default port while no container publishes it", () => {
    expect(suggestFreePort(new Map([[9000, "other-app"]]))).toBe("8000")
  })

  it("counts past a wide range of consecutive taken ports without overflowing the stack", () => {
    // One container can publish a whole host-port range, and 50,000 taken ports
    // overflow the stack of a search that recurses once per port.
    const takenPorts = Array.from({ length: 50_000 }, (_, offset) => {
      return { hostPort: 8000 + offset, containerName: "ranged" }
    })

    expect(suggestFreePort(buildPortsInUse(takenPorts))).toBe("58000")
  })

  it("suggests no port when containers publish every port from the default to 65535", () => {
    const takenPorts = Array.from({ length: 65535 - 8000 + 1 }, (_, offset) => {
      return { hostPort: 8000 + offset, containerName: "ranged" }
    })

    expect(suggestFreePort(buildPortsInUse(takenPorts))).toBeUndefined()
  })
})

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
