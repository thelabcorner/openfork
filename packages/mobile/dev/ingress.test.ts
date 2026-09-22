import { describe, expect, test } from "bun:test"
import { devIngressVerdict, isPrivateDevHost } from "./ingress"

describe("mobile dev ingress firewall", () => {
  test("recognizes loopback and private network addresses", () => {
    for (const host of [
      "localhost",
      "openfork.localhost",
      "127.0.0.1",
      "10.4.3.2",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.70",
      "169.254.10.20",
      "::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:192.168.1.70",
    ]) {
      expect(isPrivateDevHost(host)).toBe(true)
    }
  })

  test("rejects public and malformed addresses", () => {
    for (const host of ["OpenCode.theDabCorner.site", "8.8.8.8", "172.32.0.1", "example.com", "", undefined]) {
      expect(isPrivateDevHost(host)).toBe(false)
    }
  })

  test("allows direct loopback and LAN requests", () => {
    expect(devIngressVerdict({ headers: { host: "localhost:3301" }, remoteAddress: "127.0.0.1" })).toEqual({
      ok: true,
    })
    expect(
      devIngressVerdict({
        headers: { host: "192.168.1.70:3301", origin: "http://192.168.1.70:3301" },
        remoteAddress: "192.168.1.44",
      }),
    ).toEqual({ ok: true })
  })

  test("rejects public Host headers even when a local tunnel connects over loopback", () => {
    expect(
      devIngressVerdict({
        headers: { host: "OpenCode.theDabCorner.site" },
        remoteAddress: "127.0.0.1",
      }),
    ).toEqual({ ok: false, reason: "host" })
  })

  test("rejects Cloudflare and generic reverse-proxy traffic", () => {
    expect(
      devIngressVerdict({
        headers: { host: "localhost:3301", "cf-ray": "incident-probe" },
        remoteAddress: "127.0.0.1",
      }),
    ).toEqual({ ok: false, reason: "proxy" })
    expect(
      devIngressVerdict({
        headers: { host: "192.168.1.70:3301", "x-forwarded-for": "203.0.113.5" },
        remoteAddress: "192.168.1.2",
      }),
    ).toEqual({ ok: false, reason: "proxy" })
  })

  test("rejects public socket peers and public browser origins", () => {
    expect(
      devIngressVerdict({ headers: { host: "192.168.1.70:3301" }, remoteAddress: "203.0.113.9" }),
    ).toEqual({ ok: false, reason: "remote-address" })
    expect(
      devIngressVerdict({
        headers: { host: "192.168.1.70:3301", origin: "https://example.com" },
        remoteAddress: "192.168.1.44",
      }),
    ).toEqual({ ok: false, reason: "origin" })
  })
})