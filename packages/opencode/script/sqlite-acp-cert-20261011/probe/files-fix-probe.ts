// FIX VERIFICATION probe (isolated, lane-local): the compiled worker URL
// `./sqlite-bun-worker.ts` resolves only when a file with that name exists at
// the embedded root. This probe verifies the owner-ready mechanism:
//
//   1. pre-bundle the real worker to a self-contained Bun-target JS string;
//   2. pass it through Bun.build `files: { "sqlite-bun-worker.ts": text }`;
//   3. compile the real production client probe WITHOUT a nested worker entry;
//   4. run and require a real SQL round-trip.
//
// Variants:
//   files-only        - files injection, no worker entrypoint
//   files-plus-entry  - files injection plus the nested worker entrypoint
//   control-entry-only- nested worker entrypoint only (known RED)
//
// Usage: bun run probe/files-fix-probe.ts [--keep]

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneDir, "..", "..")
const packagesDir = resolve(packageRoot, "..")
const workerEntry = join(packagesDir, "core", "src", "database", "sqlite-bun-worker.ts")
const probeMain = join(import.meta.dir, "worker-probe.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""
const outDir = join(workRoot(), "probe", `files-fix-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

// 1. Pre-bundle the worker into a single self-contained JS module text.
const workerBundle = await Bun.build({
  entrypoints: [workerEntry],
  target: "bun",
  minify: true,
  splitting: false,
  write: false,
} as unknown as Parameters<typeof Bun.build>[0])
if (!workerBundle.success || workerBundle.outputs.length === 0) {
  console.log(JSON.stringify({ probe: "files-fix", stage: "worker-bundle", ok: false, logs: workerBundle.logs.map((l) => l.message) }))
  process.exit(1)
}
const workerText = await workerBundle.outputs[0]!.text()
const workerTextSha = createHash("sha256").update(workerText).digest("hex").slice(0, 16)
console.log(JSON.stringify({ probe: "files-fix", stage: "worker-bundle", ok: true, bytes: workerText.length, sha256: workerTextSha }))

type Result = Record<string, unknown>
const results: Result[] = []
const variants = [
  { name: "files-only", files: { "sqlite-bun-worker.ts": workerText }, entrypoints: [probeMain] as string[] },
  { name: "files-plus-entry", files: { "sqlite-bun-worker.ts": workerText }, entrypoints: [probeMain, workerEntry] as string[] },
  { name: "control-entry-only", files: undefined, entrypoints: [probeMain, workerEntry] as string[] },
]

for (const variant of variants) {
  const outfile = join(outDir, `${variant.name}${exeSuffix}`)
  const dbPath = join(outDir, `${variant.name}.sqlite`)
  const build = await Bun.build({
    entrypoints: variant.entrypoints,
    ...(variant.files ? { files: variant.files } : {}),
    minify: true,
    splitting: false,
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
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "files-fix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
