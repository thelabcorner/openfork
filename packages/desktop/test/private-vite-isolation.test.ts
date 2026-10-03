import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import { privateViteIsolation } from "./private-vite-isolation"

test("private Vite fixtures bind their reserved nondefault port and owned optimize cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-private-vite-test-"))
  const options = await privateViteIsolation(join(directory, "vite-cache"))
  const vite = await createServer({ configFile: false, root: directory, plugins: [], ...options })
  try {
    expect(options.server.port).toBeGreaterThan(0)
    expect(options.server.port).not.toBe(5173)
    expect(options.server.strictPort).toBe(true)
    expect(options.cacheDir).toBe(join(directory, "vite-cache"))
    expect(options.cacheDir.toLowerCase()).not.toContain("node_modules")
    await vite.listen()
    const address = vite.httpServer?.address()
    expect(address && typeof address !== "string" ? address.port : undefined).toBe(options.server.port)
    expect(resolve(vite.config.cacheDir).toLowerCase()).toBe(options.cacheDir.toLowerCase())
  } finally {
    await vite.close()
    await rm(directory, { recursive: true, force: true })
  }

  const unsafe = join(import.meta.dir, "..", "node_modules", ".vite")
  await expect(privateViteIsolation(unsafe)).rejects.toThrow(
    "must not use shared node_modules",
  )
})
