import { afterEach, describe, expect, test } from "bun:test"
import {
  DEVICE_AUTH_USERNAME,
  DEVICE_TOKEN_STORAGE_KEY,
  claimDeviceToken,
  clearDeviceToken,
  deviceCredentials,
  parsePairCode,
  readStoredDeviceToken,
  storeDeviceToken,
  stripPairParam,
  verifyDeviceToken,
} from "./pwa-pairing"

// Integration-gate verification for the PWA claim-on-boot logic (task p4).
// The module under test calls global fetch directly, so each fetch-backed
// test stubs globalThis.fetch with a house-style fetcher and restores it.

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY)
  location.hash = ""
})

function stubFetch(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      return handler(request)
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetcher as unknown as typeof globalThis.fetch
  return requests
}

describe("parsePairCode", () => {
  test("extracts a six-character code from a #pair= fragment", () => {
    expect(parsePairCode("#pair=K7M2XQ")).toBe("K7M2XQ")
  })

  test("accepts a bare fragment without the leading hash", () => {
    expect(parsePairCode("pair=K7M2XQ")).toBe("K7M2XQ")
  })

  test("tolerates additional fragment params around pair=", () => {
    expect(parsePairCode("#x=1&pair=K7M2XQ&y=2")).toBe("K7M2XQ")
  })

  test("normalizes lowercase codes to uppercase", () => {
    expect(parsePairCode("#pair=k7m2xq")).toBe("K7M2XQ")
  })

  test("rejects wrong lengths", () => {
    expect(parsePairCode("#pair=K7M2X")).toBeUndefined()
    expect(parsePairCode("#pair=K7M2XQQ")).toBeUndefined()
  })

  test("rejects absent, malformed, and non-alphanumeric codes", () => {
    expect(parsePairCode("")).toBeUndefined()
    expect(parsePairCode("#other=1")).toBeUndefined()
    expect(parsePairCode("#pair=K7M-XQ")).toBeUndefined()
    // A longer code must not match partially inside another param.
    expect(parsePairCode("#pair=K7M2XQQ&x=1")).toBeUndefined()
  })
})

describe("stripPairParam", () => {
  // history.replaceState does not reflect into location.hash under bun's DOM,
  // so the fragment surgery is tested through the pure helper; stripPairHash
  // is a thin wrapper over it.
  test("removes only the pair param and keeps other fragment params", () => {
    expect(stripPairParam("#x=1&pair=K7M2XQ&y=2")).toBe("x=1&y=2")
  })

  test("returns an empty string when pair= was the only param", () => {
    expect(stripPairParam("#pair=K7M2XQ")).toBe("")
  })

  test("returns undefined for unrelated fragments", () => {
    expect(stripPairParam("#session=ses_1")).toBeUndefined()
    expect(stripPairParam("")).toBeUndefined()
  })
})

describe("device token storage", () => {
  test("stores, reads, and clears the token under the durable key", () => {
    expect(readStoredDeviceToken()).toBeNull()
    storeDeviceToken("tok-123")
    expect(readStoredDeviceToken()).toBe("tok-123")
    clearDeviceToken()
    expect(readStoredDeviceToken()).toBeNull()
  })
})

describe("deviceCredentials", () => {
  test("uses the device username with the token as password", () => {
    expect(deviceCredentials("tok-123")).toEqual({ username: DEVICE_AUTH_USERNAME, password: "tok-123" })
    expect(DEVICE_AUTH_USERNAME).toBe("device")
  })
})

describe("claimDeviceToken", () => {
  test("exchanges a code for a token via POST /pair/claim", async () => {
    const requests = stubFetch((request) => {
      expect(request.method).toBe("POST")
      expect(new URL(request.url).pathname).toBe("/pair/claim")
      return Response.json({ token: "tok-ok", device: { id: "dev_1", name: "phone" } })
    })
    const result = await claimDeviceToken("http://localhost:4096", "K7M2XQ")
    expect(result).toEqual({ ok: true, token: "tok-ok" })
    expect(requests).toHaveLength(1)
    expect(await requests[0]!.json()).toEqual({ code: "K7M2XQ" })
  })

  test("accepts the deviceToken response field as a fallback", async () => {
    stubFetch(() => Response.json({ deviceToken: "tok-alt" }))
    expect(await claimDeviceToken("http://localhost:4096", "K7M2XQ")).toEqual({ ok: true, token: "tok-alt" })
  })

  test("reports failure with the server status on rejection", async () => {
    stubFetch(() =>
      Response.json({ name: "PairCodeError", data: { message: "expired", reason: "expired" } }, { status: 400 }),
    )
    expect(await claimDeviceToken("http://localhost:4096", "K7M2XQ")).toEqual({ ok: false, status: 400 })
  })

  test("reports failure when the body carries no token", async () => {
    stubFetch(() => Response.json({ unexpected: true }))
    expect(await claimDeviceToken("http://localhost:4096", "K7M2XQ")).toEqual({ ok: false, status: 200 })
  })

  test("reports failure without a status on network errors", async () => {
    stubFetch(() => {
      throw new TypeError("network down")
    })
    expect(await claimDeviceToken("http://localhost:4096", "K7M2XQ")).toEqual({ ok: false })
  })
})

describe("verifyDeviceToken", () => {
  test("sends the stored token as device Basic credentials to /global/health", async () => {
    const requests = stubFetch(() => Response.json({ healthy: true }))
    const verdict = await verifyDeviceToken("http://localhost:4096", "tok-123")
    expect(verdict).toBe("valid")
    expect(requests[0]!.url).toBe("http://localhost:4096/global/health")
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("device:tok-123")}`)
  })

  test("counts explicit 401/403 as invalid — the clears-token path", async () => {
    stubFetch(() => new Response(undefined, { status: 401 }))
    expect(await verifyDeviceToken("http://localhost:4096", "tok-revoked")).toBe("invalid")
    stubFetch(() => new Response(undefined, { status: 403 }))
    expect(await verifyDeviceToken("http://localhost:4096", "tok-revoked")).toBe("invalid")
  })

  test("never invalidates on server errors or network failures", async () => {
    stubFetch(() => new Response(undefined, { status: 500 }))
    expect(await verifyDeviceToken("http://localhost:4096", "tok-123")).toBe("unknown")
    stubFetch(() => {
      throw new TypeError("offline")
    })
    expect(await verifyDeviceToken("http://localhost:4096", "tok-123")).toBe("unknown")
  })
})
