// Root gradient for the verbatim copy pair: map exactly when the compiled
// worker URL stops resolving as the build root grows.

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const bisectDir = join(import.meta.dir, "bisect")
const packageRoot = resolve(laneDir, "..", "..")
const packagesDir = resolve(packageRoot, "..")
const repoRoot = resolve(packagesDir, "..")
const coreDir = join(packagesDir, "core")
const coreDatabaseDir = join(coreDir, "src", "database")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

const cases: { name: string; root: string | undefined }[] = [
  { name: "root-bisect", root: bisectDir },
  { name: "root-probe", root: resolve(bisectDir, "..") },
  { name: "root-lane", root: laneDir },
  { name: "root-package", root: packageRoot },
  { name: "root-packages", root: packagesDir },
  { name: "root-core", root: coreDir },
  { name: "root-core-database", root: coreDatabaseDir },
  { name: "root-repo", root: repoRoot },
  { name: "root-default", root: undefined },
]

const outDir = join(workRoot(), "probe", `gradient-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
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
    results.push({ case: item.name, root: item.root ?? "(default)", buildSuccess: false })
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
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean)
  const verdict = lines.find((line) => line.includes('"ok"'))
  results.push({
    case: item.name,
    root: item.root ?? "(default)",
    exitCode: code,
    verdict: verdict ? JSON.parse(verdict) : undefined,
    stderrTail: stderr.trim().split("\n").slice(-2).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
  })
}

console.log(JSON.stringify({ probe: "root-gradient", bunVersion: process.versions.bun, cwd: process.cwd(), results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
