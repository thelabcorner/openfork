import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { configureElectronFixtureProfile } from "./electron-fixture-profile"

test("fixture profiles configure and verify every effective storage path before readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "openfork-electron-profile-"))
  const stored = new Map<string, string>()
  try {
    const paths = configureElectronFixtureProfile({
      isReady: () => false,
      setPath: (name, value) => { stored.set(name, value) },
      getPath: (name) => stored.get(name)!,
    }, root)
    expect(stored.size).toBe(4)
    for (const [name, value] of Object.entries(paths)) {
      expect(stored.get(name)).toBe(value)
      expect(value.startsWith(resolve(root) + "/") || value.startsWith(resolve(root) + "\\")).toBe(true)
    }
    expect(stored.has("cache")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing, relative, or already-ready profiles fail without changing shared paths", () => {
  let writes = 0
  const app = {
    isReady: () => false,
    setPath: () => { writes++ },
    getPath: () => "unused",
  }
  expect(() => configureElectronFixtureProfile(app, undefined)).toThrow("absolute")
  expect(() => configureElectronFixtureProfile(app, "relative-profile")).toThrow("absolute")
  expect(() => configureElectronFixtureProfile({ ...app, isReady: () => true }, resolve(tmpdir()))).toThrow("before app readiness")
  expect(writes).toBe(0)
})
