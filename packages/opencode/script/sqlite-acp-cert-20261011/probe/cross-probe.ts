// Cross-layout matrix. Production topology is: main entry in one directory,
// an imported client module in another directory, and the worker file next to
// the client module. These cases isolate whether the `new URL(..., import.meta.url)`
// worker call is only embedded when it appears in an entry module or in the
// main entry's own directory.

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const layoutDir = resolve(import.meta.dir, "cross-layout")
const workerEntry = join(layoutDir, "worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

const cases: { name: string; main: string; root?: string }[] = [
  { name: "main-ref", main: "main-ref.ts" },
  { name: "host-same-dir", main: "main-host-same-dir.ts" },
  { name: "host-cross-dir", main: "app/main-cross-dir.ts" },
  { name: "host-cross-dir-root-layout", main: "app/main-cross-dir.ts", root: layoutDir },
]

const outDir = join(workRoot(), "probe", `cross-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type Result = Record<string, unknown>
const results: Result[] = []
for (const item of cases) {
  const entry = join(layoutDir, item.main)
  const outfile = join(outDir, `${item.name}${exeSuffix}`)
  const build = await Bun.build({
    ...(item.root ? { root: item.root } : {}),
    entrypoints: [entry, workerEntry],
    minify: true,
    splitting: false,
    compile: { target: targetName() as never, outfile },
  })
  if (!build.success) {
    results.push({
      case: item.name,
      root: item.root ?? "(default)",
      buildSuccess: false,
      buildLogs: build.logs.map((log) => `${log.level}: ${log.message}`).slice(0, 10),
    })
    continue
  }
  const bytes = await readFile(outfile)
  const child = Bun.spawn([outfile], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
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
    case: item.name,
    root: item.root ?? "(default)",
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "cross-layout-matrix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
