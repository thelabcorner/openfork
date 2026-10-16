import { describe, expect, test } from "bun:test"
import { PAIRED_CONNECTION_KEY, readTrustedPairing, removeTrustedPairing, writeTrustedPairing } from "./paired-storage"
import type { TrustedPairing } from "./paired-storage"

const paired: TrustedPairing = {
  serverUrl: "https://api.example.test",
  token: "one-device-secret",
  deviceID: "device-1",
  networkIdentity: { instanceID: "desktop", realmID: "realm", peerID: "peer", fingerprint: "sha256:abc", protocolMin: 1, protocolMax: 1 },
}

const memory = () => {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

describe("atomic mobile device-pair storage", () => {
  test("stores server URL, credential, and identity in one record", () => {
    const store = memory()
    expect(readTrustedPairing(store)).toEqual({ kind: "absent" })
    expect(writeTrustedPairing(store, paired)).toBe(true)
    expect(readTrustedPairing(store)).toEqual({ kind: "valid", value: paired })
    removeTrustedPairing(store)
    expect(readTrustedPairing(store)).toEqual({ kind: "absent" })
  })

  test("treats corrupt, partially updated and credential-bearing records as non-restorable", () => {
    const store = memory()
    for (const body of ["{", "{}", JSON.stringify({ version: 1, token: "secret" }),
      JSON.stringify({ version: 1, ...paired, networkIdentity: undefined }),
      JSON.stringify({ version: 1, ...paired, serverUrl: "https://api.example.test/path" }),
      JSON.stringify({ version: 1, ...paired, token: "secret\r\nHeader: value" })]) {
      store.setItem(PAIRED_CONNECTION_KEY, body)
      expect(readTrustedPairing(store)).toEqual({ kind: "corrupt" })
    }
  })

  test("write failures never report persistence success", () => {
    const blocked = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError") } }
    expect(writeTrustedPairing(blocked, paired)).toBe(false)
    expect(readTrustedPairing({ getItem: () => { throw new Error("SecurityError") } })).toEqual({ kind: "corrupt" })
  })

  test("rejects malformed credentials before writing anything to localStorage", () => {
    const store = memory()
    for (const token of ["", "invalid\nvalue", "invalid value", "x".repeat(4097)]) {
      expect(writeTrustedPairing(store, { ...paired, token })).toBe(false)
      expect(readTrustedPairing(store)).toEqual({ kind: "absent" })
    }
    expect(writeTrustedPairing(store, { ...paired, networkIdentity: { ...paired.networkIdentity, fingerprint: "" } })).toBe(false)
    expect(readTrustedPairing(store)).toEqual({ kind: "absent" })
  })

  test("permits LAN HTTP pairing restore only in development, never production", () => {
    const store = memory()
    const lan = { ...paired, serverUrl: "http://192.168.1.70:4096" }
    expect(writeTrustedPairing(store, lan)).toBe(false)
    expect(writeTrustedPairing(store, lan, { allowInsecureRemote: true })).toBe(true)
    expect(readTrustedPairing(store)).toEqual({ kind: "corrupt" })
    expect(readTrustedPairing(store, { allowInsecureRemote: true })).toEqual({ kind: "valid", value: lan })
  })
})