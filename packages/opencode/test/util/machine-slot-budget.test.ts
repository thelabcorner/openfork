import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const worker = path.join(import.meta.dir, "../fixture/machine-slot-worker.ts")

async function runWorker(input: Record<string, unknown>) {
  const proc = Bun.spawn([process.execPath, worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ])
  return { code, stdout, stderr }
}

describe("machine slot budget", () => {
  test("serializes independent processes through one machine-wide slot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-machine-slot-"))
    const locks = path.join(root, "locks")
    const active = path.join(root, "active")
    const overlap = path.join(root, "overlap")
    const done = path.join(root, "done")
    const input = {
      prefix: `test-${Date.now()}-${Math.random()}`,
      slots: 1,
      dir: locks,
      holdMs: 150,
      active,
      overlap,
      done,
    }

    try {
      const results = await Promise.all([runWorker(input), runWorker(input), runWorker(input)])
      for (const result of results) expect(result.code, result.stderr).toBe(0)
      const overlapped = await fs.readFile(overlap, "utf8").catch(() => "")
      expect(overlapped).toBe("")
      const completed = (await fs.readFile(done, "utf8")).trim().split(/\r?\n/).filter(Boolean)
      expect(completed).toHaveLength(3)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
