import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const windowsTest = process.platform === "win32" ? test : test.skip
windowsTest("compiled Windows Bun executable starts embedded SQLite worker with working RPC", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-bun-worker-compile-"))
  try {
    const outfile = join(folder, "sqlite-bun-test.exe")
    const build = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../fixture/sqlite-bun-standalone.ts"),
        resolve(import.meta.dir, "../../src/database/sqlite-bun-worker.ts"),
      ],
      compile: { target: "bun-windows-x64", outfile },
      // Bun 1.4 preserves the source filename on Worker(new URL(...)) but can
      // embed a secondary entrypoint under a different nested path. Match
      // the worker's runtime virtual-fs basename to its compiled entrypoint.
      naming: { entry: "[name].[ext]" },
      minify: true,
    })
    expect(build.success, build.logs.map((entry) => entry.message).join("\n")).toBe(true)
    const child = Bun.spawn([outfile], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, error.slice(0, 2000)).toBe(0)
    expect(output).toContain("standalone Bun SQLite worker passed")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 90_000)