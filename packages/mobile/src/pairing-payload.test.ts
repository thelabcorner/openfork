import { describe, expect, test } from "bun:test"
import { parseLinkPairCode, parsePairingPayload } from "./pairing-payload"
import { normalizeServerUrl } from "./pairing-input"

describe("mobile QR contract", () => {
  test("extracts a code and API endpoint from a valid two-origin HTTPS QR", () => {
    expect(
      parsePairingPayload(
        "https://mobile.example.test/?server=https%3A%2F%2Fapi.example.test#pair=K7M2XQ",
      ),
    ).toEqual({ code: "K7M2XQ", serverUrl: "https://api.example.test" })
  })

  test("never treats the PWA's own origin as a fallback API endpoint", () => {
    expect(parsePairingPayload("https://mobile.example.test/#pair=K7M2XQ")).toBeUndefined()
    expect(parsePairingPayload("https://mobile.example.test/?server=https://mobile.example.test#pair=K7M2XQ")).toBeUndefined()
  })

  test("rejects credential-bearing, insecure remote, and malformed target URLs", () => {
    for (const server of [
      "https://user:pass@api.example.test",
      "http://192.168.1.4:4096",
      "https://api.example.test/under/a/prefix",
      "https://api.example.test/?token=leak",
      "javascript:alert(1)",
    ]) {
      const qr = `https://mobile.example.test/?server=${encodeURIComponent(server)}#pair=K7M2XQ`
      expect(parsePairingPayload(qr)).toBeUndefined()
    }
  })

  test("supports raw valid pairing codes, without accepting random URLs as codes", () => {
    expect(parsePairingPayload("K7M2XQ")).toEqual({ code: "K7M2XQ" })
    expect(parsePairingPayload("https://api.example.test/#pair=K7M2XQ")).toBeUndefined()
    expect(parsePairingPayload("1I0OOO")).toBeUndefined()
    expect(parsePairingPayload("https://mobile.example.test/?server=https://api.example.test#pair=INVALID")).toBeUndefined()
  })

  test("rejects malformed QR secrets rather than silently taking a six-character prefix", () => {
    expect(parseLinkPairCode("K7M2XQgarbage")).toBeUndefined()
    expect(parseLinkPairCode(" K7M2XQ ")).toBe("K7M2XQ")
    expect(parseLinkPairCode("K7M2XQ-1")).toBeUndefined()
    expect(parsePairingPayload("https://mobile.example.test/?server=https%3A%2F%2Fapi.example.test#pair=K7M2XQgarbage")).toBeUndefined()
  })

  test("normalizes an API origin rather than silently dropping embedded credentials", () => {
    expect(normalizeServerUrl("https://api.example.test/")).toBe("https://api.example.test")
    expect(() => normalizeServerUrl("https://alice:secret@api.example.test")).toThrow("username or password")
    expect(() => normalizeServerUrl("https://api.example.test/a")).toThrow("API origin")
    expect(() => normalizeServerUrl("https://api.example.test/?foo=bar")).toThrow("API origin")
  })
})
