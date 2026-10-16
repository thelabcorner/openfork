// FIX candidate verification: force every entrypoint to be emitted at the
// embedded root by basename via `naming: { entry: "[name].[ext]" }`.
//
// Variants:
//   naming-probe-root  - copy pair (nested worker relative to root) + naming
//   naming-prod        - REAL production client/worker probe + naming
//   naming-prod-split  - real pair + naming + splitting (mimics build.ts)
//   bound-prod-naming  - real pair + naming + conditions + minify (build.ts-like)
//
// Usage: bun run probe/naming-fix-probe.ts [--keep]

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneDir, "..", "..")
const packagesDir = resolve(packageRoot, "..")
const probeMain = join(import.meta.dir, "worker-probe.ts")
const bisectMain = join(import.meta.dir, "bisect", "main.ts")
const workerEntry = join(packagesDir, "core", "src", "database", "sqlite-bun-worker.ts")
const bisectWorker = join(import.meta.dir, "bisect", "sqlite-bun-worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

const outDir = join(workRoot(), "probe", `naming-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type Variant = {
  name: string
  main: string
  worker: string
  root?: string
  naming: boolean
  splitting?: boolean
  conditions?: string[]
  buildOnly?: boolean
  inspectEmbedded?: boolean
}

const variants: Variant[] = [
  { name: "naming-probe-root", main: bisectMain, worker: bisectWorker, root: import.meta.dir, naming: true },
  { name: "naming-prod", main: probeMain, worker: workerEntry, naming: true },
  { name: "naming-prod-split", main: probeMain, worker: workerEntry, naming: true, splitting: true },
  {
    name: "build-parity-naming",
    main: probeMain,
    worker: workerEntry,
    naming: true,
    splitting: true,
    conditions: ["bun", "node"],
  },
  {
    name: "build-parity-naming-targeted",
    main: probeMain,
    worker: workerEntry,
    naming: false,
    splitting: true,
    conditions: ["bun", "node"],
  },
]

type Result = Record<string, unknown>
const results: Result[] = []
for (const variant of variants) {
  const outfile = join(outDir, `${variant.name}${exeSuffix}`)
  const dbPath = join(outDir, `${variant.name}.sqlite`)
  const build = await Bun.build({
    ...(variant.root ? { root: variant.root } : {}),
    ...(variant.conditions ? { conditions: variant.conditions } : {}),
    entrypoints: [variant.main, variant.worker],
    minify: true,
    splitting: variant.splitting ?? false,
    ...(variant.naming ? { naming: { entry: "[name].[ext]" } } : {}),
    compile: { target: targetName() as never, outfile },
  })
  if (!build.success) {
    results.push({ variant: variant.name, buildSuccess: false, logs: build.logs.map((l) => `${l.level}: ${l.message}`).slice(0, 10) })
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
    naming: variant.naming ? "basename" : "none",
    splitting: variant.splitting ?? false,
    conditions: variant.conditions ?? [],
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "naming-fix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
