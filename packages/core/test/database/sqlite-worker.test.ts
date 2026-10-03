import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "bun:test"

const execFileAsync = promisify(execFile)

test("Node SQLite worker RPC preserves responsiveness, transaction isolation, and result values", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".sqlite-worker-test-"))
  try {
    const outfile = join(directory, "sqlite-worker-node.js")
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../fixture/sqlite-worker-node.ts")],
      target: "node",
      format: "esm",
      packages: "external",
      outdir: directory,
    })
    expect(build.outputs.some((output) => output.path.endsWith("sqlite-worker-node.js"))).toBe(true)
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)

    const result = await execFileAsync("node", [outfile], {
      cwd: resolve(import.meta.dir, "../../../../"),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })
    expect(result.stdout).toContain("sqlite worker RPC fixture passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
