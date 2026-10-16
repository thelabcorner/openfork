import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./bootstrap.tsx", import.meta.url)).text()
const clientSource = await Bun.file(new URL("./pairing-client.ts", import.meta.url)).text()

describe("mobile bootstrap boundary", () => {
  test("loads the shared runtime dynamically, never statically", () => {
    expect(source).toContain('import("@opencode-ai/app/pwa-client")')
    expect(source).not.toMatch(/^import (?!type ).*@opencode-ai\/app\/pwa-client/m)
  })

  test("persists the authenticated tuple atomically, without independent token writes", () => {
    const writeTuple = source.indexOf("persistTrustedPairing({ serverUrl: normalizedServer, token: claimed.token")
    expect(writeTuple).toBeGreaterThan(-1)
    expect(source).not.toContain("writeStorage(DEVICE_TOKEN_KEY, claimed.token)")
    expect(source).not.toContain("writeNetworkIdentity(claimed.networkIdentity)")
    expect(source).toContain('const trusted = loadTrustedPairing()')
    expect(source).toContain('const legacy = trusted.kind === "absent"')
  })

  test("verifies the public identity before sending the device credential", () => {
    const restoreProbe = source.indexOf("liveIdentity = await probeNetworkIdentity(normalizedServer, fetch, attempt.signal)")
    const restoreCredential = source.indexOf("const verdict = await credentialVerdict(normalizedServer, storedToken, fetch, attempt.signal)")
    expect(restoreProbe).toBeGreaterThan(-1)
    expect(restoreCredential).toBeGreaterThan(-1)
    expect(restoreProbe).toBeLessThan(restoreCredential)

    const migrateProbe = source.indexOf("pinnedIdentityVerdict(pinned, await probeNetworkIdentity(normalized, fetch, attempt.signal))")
    const migrateCredential = source.indexOf("const credential = await credentialVerdict(normalized, token, fetch, attempt.signal)")
    expect(migrateProbe).toBeGreaterThan(-1)
    expect(migrateCredential).toBeGreaterThan(-1)
    expect(migrateProbe).toBeLessThan(migrateCredential)

    const legacyGuard = source.indexOf("storedToken && !canRestoreDeviceToken(storedToken, storedIdentity)")
    expect(legacyGuard).toBeGreaterThan(-1)
    expect(legacyGuard).toBeLessThan(restoreCredential)
    expect(clientSource).toContain('cache: "no-store"')
  })
  test("revocation invalidates pending asynchronous operations before deleting credentials", () => {
    expect(source.indexOf("const attempts = createAttemptGate()")).toBeGreaterThan(-1)
    const forget = source.indexOf("const forget = () => {")
    const invalidate = source.indexOf("attempts.invalidate()", forget)
    const removeToken = source.indexOf("clearStorage(DEVICE_TOKEN_KEY)", forget)
    expect(invalidate).toBeGreaterThan(forget)
    expect(invalidate).toBeLessThan(removeToken)
    expect(source).toContain("if (!attempt.current()) return")
  })
})
