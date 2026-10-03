import { execFile } from "node:child_process"
import { mkdtemp, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "bun:test"

const execFileAsync = promisify(execFile)

test("isolated Electron sidecar control transport and native SQLite worker gate", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".electron-gate-test-"))
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "electron-control-worker-gate.ts")],
      target: "node",
      format: "cjs",
      packages: "external",
      outdir: directory,
    })
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)
    const fixture = join(directory, "electron-control-worker-gate.js")
    const main = join(directory, "electron-control-worker-gate.cjs")
    await rename(fixture, main)

    const electron = resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe")
    const result = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", main], {
      cwd: resolve(import.meta.dir, "../../.."),
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const marker = result.stdout.split("\n").find((line) => line.startsWith("ELECTRON_GATE_RESULT "))
    expect(marker, result.stdout + result.stderr).toBeTruthy()
    const evidence = JSON.parse(marker!.slice("ELECTRON_GATE_RESULT ".length)) as {
      electron: string
      node: string
      chromium: string
      defaultSessionHeldAtControlCompletion: number
      controlCompletionMs: number
      cancellationObserved: number
      streams: Array<{ concurrency: number; bytes: number }>
      sqliteWorkerQueryMs: number
      parentHeartbeatsDuringSqlite: number
    }
    expect(evidence.electron).toBeTruthy()
    expect(evidence.node).toBeTruthy()
    expect(evidence.chromium).toBeTruthy()
    expect(evidence.defaultSessionHeldAtControlCompletion).toBeGreaterThan(0)
    expect(evidence.cancellationObserved).toBeGreaterThan(0)
    expect(evidence.streams.map((item) => item.concurrency)).toEqual([1, 3, 6])
    expect(evidence.streams.every((item) => item.bytes > 0)).toBe(true)
    expect(evidence.parentHeartbeatsDuringSqlite).toBeGreaterThan(0)
    console.log("Electron gate evidence:", evidence)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
