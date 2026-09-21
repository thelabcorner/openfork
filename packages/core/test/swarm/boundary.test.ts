import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"

const allowedParentImports = new Set([
  "../control-plane/workspace.sql",
  "../database/database",
  "../database/path",
  "../effect/app-node",
  "../event",
  "../project/sql",
  "../schema",
  "../session/metadata-ownership",
  "../session/sql",
])

describe("Swarm Core dependency boundary", () => {
  test("depends only on durable Tier-0/1 Core owners, never runtime/session-history services", async () => {
    const root = new URL("../../src/swarm/", import.meta.url)
    const files = (await readdir(root)).filter((name) => name.endsWith(".ts")).sort()
    const violations: string[] = []

    for (const file of files) {
      const source = await readFile(new URL(file, root), "utf8")
      for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) {
        const specifier = match[1]!
        if (!specifier.startsWith("../")) continue
        if (allowedParentImports.has(specifier)) continue
        violations.push(`${file}: ${specifier}`)
      }
    }

    expect(violations).toEqual([])
  })
})
