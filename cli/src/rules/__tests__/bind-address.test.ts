import { describe, expect, it } from "vitest"

import {
  describeStrandedLoopbackPublicUrl,
  hostHealthUrl,
  isValidBindAddress,
} from "../bind-address.js"

describe("isValidBindAddress", () => {
  it.each([
    { label: "IPv4 loopback", value: "127.0.0.1" },
    { label: "the IPv4 wildcard", value: "0.0.0.0" },
    { label: "a network IPv4 address", value: "192.168.1.20" },
    { label: "a bracketed IPv6 address", value: "[::1]" },
    { label: "the bracketed IPv6 wildcard", value: "[::]" },
  ])("accepts $label", ({ value }) => {
    expect(isValidBindAddress(value)).toBe(true)
  })

  it.each([
    { label: "a hostname", value: "localhost" },
    { label: "a bare IPv6 address", value: "::1" },
    { label: "a zone-scoped IPv6 address", value: "[fe80::1%eth0]" },
    { label: "an address with a port", value: "127.0.0.1:8000" },
    { label: "an incomplete IPv4 address", value: "192.168.1" },
    { label: "an address padded with spaces", value: " 127.0.0.1 " },
  ])("refuses $label", ({ value }) => {
    expect(isValidBindAddress(value)).toBe(false)
  })
})

describe("describeStrandedLoopbackPublicUrl", () => {
  it.each([
    { label: "localhost", publicUrl: "http://localhost:8000" },
    { label: "127.0.0.1", publicUrl: "http://127.0.0.1:8000" },
    { label: "[::1]", publicUrl: "http://[::1]:8000" },
  ])(
    "warns when a network BIND_ADDRESS leaves a $label PUBLIC_URL unreachable",
    ({ publicUrl }) => {
      expect(
        describeStrandedLoopbackPublicUrl({
          targetDir: "/home/user/vault-cortex",
          port: 8000,
          bindAddress: "192.168.1.20",
          publicUrl,
        }),
      ).toBe(
        `BIND_ADDRESS publishes the port on 192.168.1.20 only, so PUBLIC_URL (${publicUrl}) no longer reaches the server — ` +
          "set PUBLIC_URL to the address clients use, such as http://192.168.1.20:8000, in /home/user/vault-cortex/.env.",
      )
    },
  )

  it.each([
    {
      label: "a loopback BIND_ADDRESS",
      bindAddress: "127.0.0.1",
      publicUrl: "http://localhost:8000",
    },
    {
      label: "an IPv6 loopback BIND_ADDRESS",
      bindAddress: "[::1]",
      publicUrl: "http://[::1]:8000",
    },
    { label: "no BIND_ADDRESS", bindAddress: "", publicUrl: "http://localhost:8000" },
    { label: "BIND_ADDRESS 0.0.0.0", bindAddress: "0.0.0.0", publicUrl: "http://localhost:8000" },
    { label: "BIND_ADDRESS [::]", bindAddress: "[::]", publicUrl: "http://localhost:8000" },
    {
      label: "a PUBLIC_URL at the network BIND_ADDRESS",
      bindAddress: "192.168.1.20",
      publicUrl: "http://192.168.1.20:8000",
    },
    {
      label: "a PUBLIC_URL on a domain",
      bindAddress: "192.168.1.20",
      publicUrl: "https://vault.example.com",
    },
  ])("does not warn with $label", ({ bindAddress, publicUrl }) => {
    expect(
      describeStrandedLoopbackPublicUrl({
        targetDir: "/home/user/vault-cortex",
        port: 8000,
        bindAddress,
        publicUrl,
      }),
    ).toBeUndefined()
  })
})

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
