import { describe, expect, test } from "bun:test"
import { normalizePairCode, normalizeServerUrl, validPairCode } from "./pairing-input"

describe("mobile pairing input", () => {
  test("normalizes pairing codes to the unambiguous alphabet shape", () => {
    expect(normalizePairCode("k7m-2xq")).toBe("K7M2XQ")
    expect(normalizePairCode("ab c")).toBe("ABC")
  })

  test("accepts only complete codes from the unambiguous alphabet", () => {
    expect(validPairCode("K7M2XQ")).toBe(true)
    expect(validPairCode("K7M2X")).toBe(false)
    expect(validPairCode("K7M2X0")).toBe(false)
    expect(validPairCode("K7M2XI")).toBe(false)
  })

  test("requires HTTPS for remote servers and allows loopback URLs", () => {
    expect(normalizeServerUrl("https://api.example.com/")).toBe("https://api.example.com")
    expect(normalizeServerUrl("http://localhost:4096")).toBe("http://localhost:4096")
    expect(normalizeServerUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096")
    expect(() => normalizeServerUrl("http://api.example.com")).toThrow()
    expect(normalizeServerUrl("http://api.example.com", { allowInsecureRemote: true })).toBe("http://api.example.com")
  })

  test("strips credentials and fragments from the persisted endpoint", () => {
    expect(normalizeServerUrl("https://user:pass@api.example.com/base#pair=ABC")).toBe("https://api.example.com/base")
  })

  test("rejects non-HTTP schemes and empty input", () => {
    expect(() => normalizeServerUrl("javascript:alert(1)")).toThrow()
    expect(() => normalizeServerUrl("")).toThrow()
  })
})
