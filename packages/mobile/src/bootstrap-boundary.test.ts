import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./bootstrap.tsx", import.meta.url)).text()

describe("mobile bootstrap boundary", () => {
  test("loads the shared runtime dynamically, never statically", () => {
    expect(source).toContain('import("@opencode-ai/app/pwa-client")')
    expect(source).not.toMatch(/^import (?!type ).*@opencode-ai\/app\/pwa-client/m)
  })

  test("verifies the public identity before sending the device credential", () => {
    const restoreProbe = source.indexOf("liveIdentity = await probeNetworkIdentity(normalizedServer)")
    const restoreCredential = source.indexOf("const verdict = await credentialVerdict(normalizedServer, storedToken)")
    expect(restoreProbe).toBeGreaterThan(-1)
    expect(restoreCredential).toBeGreaterThan(-1)
    expect(restoreProbe).toBeLessThan(restoreCredential)

    const migrateProbe = source.indexOf("pinnedIdentityVerdict(pinned, await probeNetworkIdentity(normalized))")
    const migrateCredential = source.indexOf("const credential = await credentialVerdict(normalized, token)")
    expect(migrateProbe).toBeGreaterThan(-1)
    expect(migrateCredential).toBeGreaterThan(-1)
    expect(migrateProbe).toBeLessThan(migrateCredential)

    expect(source).toContain('cache: "no-store"')
  })
})
