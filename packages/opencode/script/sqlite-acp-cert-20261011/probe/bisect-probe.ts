// Bisection driver: does a verbatim lane copy of the production client/worker
// pair behave differently from the real files? If the copy is GREEN while the
// real pair is RED, the trigger is provenance/location, not module content.

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const bisectDir = resolve(import.meta.dir, "bisect")
const packagesDir = resolve(import.meta.dir, "..", "..", "..")
const repoRoot = resolve(packagesDir, "..")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

const cases = [
  { name: "copy-pair", root: undefined as string | undefined },
  { name: "copy-pair-repo-root", root: repoRoot },
]

const outDir = join(workRoot(), "probe", `bisect-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type Result = Record<string, unknown>
const results: Result[] = []
for (const item of cases) {
  const outfile = join(outDir, `${item.name}${exeSuffix}`)
  const dbPath = join(outDir, `${item.name}.sqlite`)
  const build = await Bun.build({
    ...(item.root ? { root: item.root } : {}),
    entrypoints: [join(bisectDir, "main.ts"), join(bisectDir, "sqlite-bun-worker.ts")],
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
    case: item.name,
    root: item.root ?? "(default)",
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "bisect-matrix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
