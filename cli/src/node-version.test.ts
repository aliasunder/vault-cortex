import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { minimumNodeVersion, satisfiesMinimum } from "./node-version.js"

describe("minimumNodeVersion", () => {
  it("extracts the floor from a >= range", () => {
    const minimum = minimumNodeVersion(">=20.12.0")

    expect(minimum).toBe("20.12.0")
  })

  it("defaults a missing patch segment to 0", () => {
    const minimum = minimumNodeVersion(">=20.12")

    expect(minimum).toBe("20.12.0")
  })

  it("parses the actual engines range in cli/package.json", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { engines: { node: string } }

    const minimum = minimumNodeVersion(manifest.engines.node)

    expect(minimum).toBe("20.12.0")
  })

  it("throws on a range with no version in it", () => {
    expect(() => minimumNodeVersion("latest")).toThrow(
      "Cannot parse engines range",
    )
  })
})

describe("satisfiesMinimum", () => {
  const scenarios = [
    {
      name: "equal version satisfies",
      current: "20.12.0",
      minimum: "20.12.0",
      expected: true,
    },
    {
      name: "newer patch satisfies",
      current: "20.12.1",
      minimum: "20.12.0",
      expected: true,
    },
    {
      name: "newer minor satisfies",
      current: "20.13.0",
      minimum: "20.12.0",
      expected: true,
    },
    {
      name: "newer major satisfies",
      current: "22.1.0",
      minimum: "20.12.0",
      expected: true,
    },
    {
      name: "older patch fails",
      current: "20.12.0",
      minimum: "20.12.1",
      expected: false,
    },
    {
      name: "older minor fails",
      current: "20.11.9",
      minimum: "20.12.0",
      expected: false,
    },
    {
      name: "older major fails",
      current: "18.19.0",
      minimum: "20.12.0",
      expected: false,
    },
    {
      name: "major beats minor (21.0.0 vs 20.12.0)",
      current: "21.0.0",
      minimum: "20.12.0",
      expected: true,
    },
  ]

  it.each(scenarios)("$name", ({ current, minimum, expected }) => {
    const satisfied = satisfiesMinimum(current, minimum)

    expect(satisfied).toBe(expected)
  })
})
