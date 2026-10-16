// Shape matrix: inline vs production-variable `new Worker(new URL(...))` under
// `bun build --compile`, with and without splitting. Answers whether Bun 1.4.3
// embeds the worker for both call shapes or only for the inline literal form.
//
// Usage: bun run probe/shape-probe.ts [--keep]

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneRoot = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneRoot, "..", "..")
const workerEntry = resolve(packageRoot, "..", "core", "src", "database", "sqlite-bun-worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

type ShapeResult = {
  shape: string
  splitting: boolean
  buildSuccess: boolean
  buildLogs?: string[]
  exitCode?: number
  stdout?: string[]
  stderrTail?: string
  binarySha256?: string
  binaryBytes?: number
}

const outDir = join(workRoot(), "probe", `shapes-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const results: ShapeResult[] = []
for (const shape of ["inline", "variable"] as const) {
  for (const splitting of [true, false]) {
    const entry = join(import.meta.dir, `worker-shape-${shape}.ts`)
    const outfile = join(outDir, `${shape}-${splitting ? "split" : "nosplit"}-probe${exeSuffix}`)
    const dbPath = join(outDir, `${shape}-${splitting ? "split" : "nosplit"}.sqlite`)
    const build = await Bun.build({
      conditions: ["bun", "node"],
      entrypoints: [entry, workerEntry],
      minify: true,
      splitting,
      compile: { target: targetName() as never, outfile },
    })
    if (!build.success) {
      results.push({
        shape,
        splitting,
        buildSuccess: false,
        buildLogs: build.logs.map((log) => `${log.level}: ${log.message}`).slice(0, 10),
      })
      continue
    }
    const bytes = await readFile(outfile)
    const child = Bun.spawn([outfile, dbPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const code = await Promise.race([
      child.exited,
      new Promise<number>((resolveTimeout) => setTimeout(() => resolveTimeout(-999), 30_000)),
    ])
    if (child.exitCode === null) {
      try {
        child.kill()
      } catch {}
    }
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    results.push({
      shape,
      splitting,
      buildSuccess: true,
      exitCode: code,
      stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      stderrTail: stderr.trim().split("\n").slice(-5).join("\n"),
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
      binaryBytes: bytes.length,
    })
  }
}

console.log(
  JSON.stringify(
    { probe: "worker-shape-matrix", bunVersion: process.versions.bun, workerEntry, outDir, results },
    null,
    2,
  ),
)
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
