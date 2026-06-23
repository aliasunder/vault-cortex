import { describe, it, expect } from "vitest"
import { describeError } from "../describe-error.js"

describe("describeError", () => {
  const scenarios = [
    {
      name: "returns an Error's message",
      input: new Error("boom"),
      expected: "boom",
    },
    {
      name: "returns the message of an Error subclass",
      input: new TypeError("bad type"),
      expected: "bad type",
    },
    {
      name: "stringifies a non-Error string",
      input: "plain string",
      expected: "plain string",
    },
    {
      name: "stringifies a non-Error number",
      input: 42 as unknown,
      expected: "42",
    },
    { name: "stringifies null", input: null as unknown, expected: "null" },
    {
      name: "stringifies undefined",
      input: undefined as unknown,
      expected: "undefined",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(describeError(input)).toBe(expected)
  })
})
