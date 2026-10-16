import { describe, expect, test } from "bun:test"
import { canRestoreDeviceToken, claimPair, credentialVerdict, probeNetworkIdentity, type PairingFetch } from "./pairing-client"
import type { NetworkIdentity } from "./network-identity"

const identity: NetworkIdentity = {
  instanceID: "desktop-a",
  realmID: "realm-a",
  peerID: "ofxp_peer_a",
  fingerprint: "sha256:abc",
  protocolMin: 1,
  protocolMax: 1,
}

function projection(value: NetworkIdentity = identity) {
  return {
    instanceID: value.instanceID,
    realmID: value.realmID,
    ofxp: {
      enabled: true,
      peerID: value.peerID,
      fingerprint: value.fingerprint,
      protocolMin: value.protocolMin,
      protocolMax: value.protocolMax,
    },
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("mobile pairing credential firewall", () => {
  test("refuses to submit a bearer pairing code to an endpoint without a verifiable identity", async () => {
    const paths: string[] = []
    const request = (async (url: URL, init?: RequestInit) => {
      paths.push(url.pathname)
      expect(init?.credentials).toBe("omit")
      expect(init?.redirect).toBe("error")
      expect(init?.cache).toBe("no-store")
      return new Response("<html>Proxy login</html>", { status: 200 })
    }) as PairingFetch
    await expect(claimPair("https://api.example.test", "K7M2XQ", request)).rejects.toThrow("Pairing was not attempted")
    expect(paths).toEqual(["/instance/identity"])
  })

  test("issues a token only after preclaim and postclaim identity continuity", async () => {
    const paths: string[] = []
    const request = (async (url: URL, init?: RequestInit) => {
      paths.push(url.pathname)
      if (url.pathname === "/instance/identity") return json(projection())
      expect(init?.method).toBe("POST")
      expect(init?.credentials).toBe("omit")
      expect(init?.redirect).toBe("error")
      expect(init?.cache).toBe("no-store")
      expect(JSON.parse(String(init?.body))).toEqual({ code: "K7M2XQ", name: "OpenFork Mobile" })
      return json({ token: "device-secret", device: { id: "device-a" } })
    }) as PairingFetch
    const result = await claimPair("https://api.example.test", "K7M2XQ", request)
    expect(result).toEqual({ token: "device-secret", deviceID: "device-a", networkIdentity: identity })
    expect(paths).toEqual(["/instance/identity", "/pair/claim", "/instance/identity"])
  })

  test("discards an issued token if the endpoint's identity changes during claim", async () => {
    let probes = 0
    const request = (async (url: URL) => {
      if (url.pathname === "/pair/claim") return json({ token: "must-not-be-stored" })
      probes++
      return json(projection(probes === 1 ? identity : { ...identity, fingerprint: "sha256:changed" }))
    }) as PairingFetch
    await expect(claimPair("https://api.example.test", "K7M2XQ", request)).rejects.toThrow("identity changed")
    expect(probes).toBe(2)
  })

  test("preserves server rate-limit errors without issuing a credential", async () => {
    const request = (async (url: URL) =>
      url.pathname === "/instance/identity"
        ? json(projection())
        : json({ data: { retryAfterMs: 3300 } }, 429)) as PairingFetch
    await expect(claimPair("https://api.example.test", "K7M2XQ", request)).rejects.toThrow("4s")
  })

  test("sends explicit Bearer authentication on health, never browser Basic authentication", async () => {
    const seen: RequestInit[] = []
    const request = (async (_url: URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return json({}, 200)
    }) as PairingFetch
    expect(await credentialVerdict("https://api.example.test", "device-secret", request)).toBe("valid")
    expect(seen[0]?.headers).toEqual({ Authorization: "Bearer device-secret" })
    expect(seen[0]?.cache).toBe("no-store")
    expect(seen[0]?.credentials).toBe("omit")
    expect(seen[0]?.redirect).toBe("error")
  })

  test("distinguishes credential revocation from offline and transient failures", async () => {
    const failing = (status: number) => (async () => json({}, status)) as PairingFetch
    expect(await credentialVerdict("https://api.example.test", "token", failing(401))).toBe("invalid")
    expect(await credentialVerdict("https://api.example.test", "token", failing(403))).toBe("invalid")
    expect(await credentialVerdict("https://api.example.test", "token", failing(503))).toBe("unknown")
    expect(await credentialVerdict("https://api.example.test", "token", (async () => {
      throw new TypeError("Network unreachable")
    }) as PairingFetch)).toBe("unknown")
  })

  test("disallows restoration of legacy device tokens without an identity pin", () => {
    expect(canRestoreDeviceToken("old-device-secret", undefined)).toBe(false)
    expect(canRestoreDeviceToken("old-device-secret", identity)).toBe(true)
    expect(canRestoreDeviceToken(undefined, undefined)).toBe(true)
  })

  test("cancellation stops an uncooperative fetch and never sends a pairing secret", async () => {
    const controller = new AbortController()
    const paths: string[] = []
    const hung = (async (url: URL) => {
      paths.push(url.pathname)
      return new Promise<Response>(() => {})
    }) as PairingFetch
    const claim = claimPair("https://api.example.test", "K7M2XQ", hung, controller.signal)
    const probe = probeNetworkIdentity("https://api.example.test", hung, controller.signal)
    const health = credentialVerdict("https://api.example.test", "secret", hung, controller.signal)
    controller.abort()
    await expect(claim).rejects.toHaveProperty("name", "AbortError")
    expect(await probe).toBeUndefined()
    expect(await health).toBe("unknown")
    expect(paths).not.toContain("/pair/claim")
  })

  test("pre-aborted pairing does not issue any network requests", async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const request = (async () => { called = true; return json(projection()) }) as PairingFetch
    await expect(claimPair("https://api.example.test", "K7M2XQ", request, controller.signal)).rejects.toHaveProperty("name", "AbortError")
    expect(await probeNetworkIdentity("https://api.example.test", request, controller.signal)).toBeUndefined()
    expect(called).toBe(false)
  })

  test("rejects malformed device tokens returned by the claim endpoint", async () => {
    for (const token of ["", "bad\r\nAuthorization: forged", "token with spaces", "a".repeat(4097)]) {
      const request = (async (url: URL) => url.pathname === "/instance/identity"
        ? json(projection()) : json({ token })) as PairingFetch
      await expect(claimPair("https://api.example.test", "K7M2XQ", request)).rejects.toThrow("valid device token")
    }
  })
})
