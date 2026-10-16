import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

describe("OXP production sidecar single-artifact lazy boundary", () => {
  test("keeps the refreshable node.js bundling contract explicit", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dir, "../../script/build-node.ts"), "utf8")
    expect(source).toMatch(/entrypoints: \["\.\/src\/node\.ts"\],[\s\S]*?splitting: false/)
    expect(source).toContain("Node sidecar must remain a single node.js artifact")
    expect(source).toContain("jsOutputs.length !== 1")
  })

  test("Bun single-artifact bundling preserves deferred module evaluation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-lazy-bundle-"))
    const marker = `__oxp_lazy_bundle_${Math.random().toString(36).slice(2)}`
    try {
      const entry = path.join(dir, "entry.ts")
      await fs.writeFile(entry, "export const load = () => import('./active.ts')\n")
      await fs.writeFile(path.join(dir, "active.ts"), `globalThis[${JSON.stringify(marker)}] = true; export const value = 42\n`)
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: path.join(dir, "out"),
        target: "node",
        format: "esm",
        splitting: false,
      })
      expect(result.success).toBe(true)
      const js = result.outputs.filter((output) => output.path.endsWith(".js"))
      expect(js).toHaveLength(1)
      const module = await import(pathToFileURL(js[0]!.path).href)
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
      expect((await module.load()).value).toBe(42)
      expect((globalThis as Record<string, unknown>)[marker]).toBe(true)
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})