import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const own = new Set<string>()
afterAll(async () => {
  for (const dir of own) await fs.rm(dir, { recursive: true, force: true })
})

describe("production OXP host deferred-execution listener", () => {
  for (const mode of ["normal", "catalog", "race"] as const) test(
    mode === "catalog"
      ? "allows enabled Tier-2 worker agent catalog before the first MCP executable call"
      : mode === "race"
        ? "does not resurrect a stopped endpoint during racing first-call admission"
        : "binds and lists without active runtime, coalesces first 100 calls, revokes and stops",
    async () => {
    const catalogFirst = mode === "catalog"
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-host-lazy-"))
    own.add(dir)
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      OPENCODE_TEST_HOME: path.join(dir, "home"),
      OXP_LAZY_FIXTURE_ROOT: path.join(dir, "workspace"),
      ...(catalogFirst ? { OXP_TEST_CATALOG_FIRST: "1" } : {}),
      ...(mode === "race" ? { OXP_TEST_RACE_STOP: "1" } : {}),
    }
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "fixture-host-lazy.ts")], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    // A stalled native catalog owner must never pin the test runner (or CI)
    // indefinitely. Only terminate this fixture child, never another process.
    const deadline = setTimeout(() => child.kill(), catalogFirst ? 22_000 : 45_000)
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(deadline)
    expect(exit, stderr.slice(-4000) + "\n" + stdout.slice(-1500)).toBe(0)
    const recorded = (label: string) => {
      const row = stdout.split(/\r?\n/).find((line) => line.startsWith(label + " "))
      return row?.slice(label.length + 1)
    }
    const ready = JSON.parse(recorded("OXP_READY")!)
    const listed = JSON.parse(recorded("OXP_LIST")!)
    expect(ready.heapMiB).toBeLessThan(80)
    expect(listed.count).toBe(14)
    if (!catalogFirst) expect(listed.heapMiB).toBeLessThan(80)
    if (catalogFirst) expect(JSON.parse(recorded("OXP_CATALOG")!).listed).toBe(true)
    if (mode === "race") {
      const race = JSON.parse(recorded("OXP_RACE")!)
      expect(race.stopped).toBe(true)
      expect(race.oldEndpointRejected).toBe(true)
    } else {
      const executed = JSON.parse(recorded("OXP_EXEC")!)
      const revoked = JSON.parse(recorded("OXP_REVOKED")!)
      expect(executed.count).toBe(100)
      expect(executed.calls).toBeGreaterThanOrEqual(100)
      expect(revoked.rejected).toBe(true)
    }
    expect(JSON.parse(recorded("OXP_STOPPED")!).stopped).toBe(true)
  }, 90_000)
})
