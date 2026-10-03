import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rotateLogHistory } from "./log-retention"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("desktop log retention", () => {
  test("keeps five complete 5MB-era generations instead of one .old file", () => {
    const root = mkdtempSync(join(import.meta.dir, ".log-retention-test-"))
    roots.push(root)
    const file = join(root, "server.log")

    for (let generation = 1; generation <= 7; generation++) {
      writeFileSync(file, `generation-${generation}`)
      rotateLogHistory(file, 5)
    }

    expect(readFileSync(join(root, "server.1.log"), "utf8")).toBe("generation-7")
    expect(readFileSync(join(root, "server.2.log"), "utf8")).toBe("generation-6")
    expect(readFileSync(join(root, "server.3.log"), "utf8")).toBe("generation-5")
    expect(readFileSync(join(root, "server.4.log"), "utf8")).toBe("generation-4")
    expect(readFileSync(join(root, "server.5.log"), "utf8")).toBe("generation-3")
  })
})