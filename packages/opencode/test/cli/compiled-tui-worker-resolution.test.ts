import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * A compiled Bun CLI must start its secondary TUI worker from its embedded
 * virtual FS, NOT the current project's working directory. This is the exact
 * Worker("./worker.js") path contract required by script/build.ts's flattened
 * [name].[ext] entrypoint policy. The Core SQLite worker uses a separate URL
 * contract covered by sqlite-bun-standalone.test.ts.
 */
const windowsTest = process.platform === "win32" ? test : test.skip

windowsTest("packaged TUI worker basename resolves from an unrelated cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfork-compiled-tui-worker-"))
  try {
    const main = join(dir, "main.ts")
    const worker = join(dir, "worker.js")
    const exe = join(dir, "compiled.exe")
    await writeFile(main, [
      'import { Worker } from "node:worker_threads"',
      'const worker = new Worker("./worker.js")',
      'const result = await new Promise((resolve, reject) => {',
      '  const timer = setTimeout(() => reject(new Error("embedded worker did not reply")), 5000)',
      '  worker.once("message", (value) => { clearTimeout(timer); resolve(value) })',
      '  worker.once("error", (cause) => { clearTimeout(timer); reject(cause) })',
      '})',
      'console.log("EMBEDDED_TUI_WORKER_OK", JSON.stringify(result))',
      'await worker.terminate()',
    ].join("\n"))
    await writeFile(worker,
      'import { parentPort } from "node:worker_threads"; parentPort?.postMessage({ ok: true })')
    const build = await Bun.build({
      root: dir,
      entrypoints: [main, worker],
      naming: { entry: "[name].[ext]" },
      compile: { target: "bun-windows-x64", outfile: exe },
    })
    expect(build.success, build.logs.map((x) => x.message).join("\n")).toBe(true)
    const child = Bun.spawn([exe], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, error.slice(-1500)).toBe(0)
    expect(output).toContain('EMBEDDED_TUI_WORKER_OK {"ok":true}')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  }
}, 30_000)
