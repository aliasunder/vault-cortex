import { describe, expect, it } from "vitest"

import { hostHealthUrl } from "../bind-address.js"

describe("hostHealthUrl", () => {
  it.each([
    {
      label: "IPv4 loopback when no address is given",
      bindAddress: "",
      url: "http://127.0.0.1:9000/healthz",
    },
    {
      label: "loopback for an IPv4 wildcard",
      bindAddress: "0.0.0.0",
      url: "http://127.0.0.1:9000/healthz",
    },
    {
      label: "loopback for an IPv6 wildcard",
      bindAddress: "[::]",
      url: "http://[::1]:9000/healthz",
    },
    {
      label: "a loopback address as given",
      bindAddress: "127.0.0.1",
      url: "http://127.0.0.1:9000/healthz",
    },
    {
      label: "a specific address as given",
      bindAddress: "192.168.1.20",
      url: "http://192.168.1.20:9000/healthz",
    },
    { label: "an IPv6 address as given", bindAddress: "[::1]", url: "http://[::1]:9000/healthz" },
  ])("polls $label", ({ bindAddress, url }) => {
    expect(hostHealthUrl({ bindAddress, port: 9000 })).toBe(url)
  })
})
