// Root-sensitivity probe: compile the REAL production client probe with the
// worker source inside vs outside `Bun.build({ root })`. The production build
// (`script/build.ts`) runs with cwd/root = packages/opencode while the worker
// entrypoint is `../core/src/database/sqlite-bun-worker.ts` (outside root).
//
// Usage: bun run probe/root-probe.ts [--keep]

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneDir, "..", "..")
const packagesDir = resolve(packageRoot, "..")
const repoRoot = resolve(packagesDir, "..")
const probeEntry = join(import.meta.dir, "worker-probe.ts")
const workerEntry = join(packagesDir, "core", "src", "database", "sqlite-bun-worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

const variants: { name: string; root?: string }[] = [
  { name: "root-lane", root: laneDir },
  { name: "root-package", root: packageRoot },
  { name: "root-packages", root: packagesDir },
  { name: "root-repo", root: repoRoot },
  { name: "root-default" },
]

const outDir = join(workRoot(), "probe", `roots-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type Result = Record<string, unknown>
const results: Result[] = []
for (const variant of variants) {
  const outfile = join(outDir, `${variant.name}${exeSuffix}`)
  const dbPath = join(outDir, `${variant.name}.sqlite`)
  const build = await Bun.build({
    ...(variant.root ? { root: variant.root } : {}),
    entrypoints: [probeEntry, workerEntry],
    minify: true,
    splitting: false,
    compile: { target: targetName() as never, outfile },
  })
  if (!build.success) {
    results.push({
      variant: variant.name,
      root: variant.root ?? "(default)",
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
    variant: variant.name,
    root: variant.root ?? "(default)",
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "root-matrix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
