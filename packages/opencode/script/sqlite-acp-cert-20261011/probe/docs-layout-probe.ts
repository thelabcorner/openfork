// Docs-layout matrix. Mirrors the official Bun standalone worker example:
// `main.ts` and `worker.ts` sit in the same directory, `bun build --compile`
// receives both as entrypoints, and the host launches the worker via one of the
// documented forms. Variants isolate: launch form, `root`, `splitting`, and
// `conditions` (the production build sets conditions/splitting/minify).

import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const layoutDir = resolve(import.meta.dir, "docs-layout")
const workerEntry = join(layoutDir, "docs-worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const exeSuffix = process.platform === "win32" ? ".exe" : ""

type Variant = {
  name: string
  main: string
  root?: string
  splitting: boolean
  conditions?: string[]
}

const variants: Variant[] = [
  { name: "string-root-layout", main: "docs-main-string.ts", root: layoutDir, splitting: false },
  { name: "string-root-default", main: "docs-main-string.ts", splitting: false },
  { name: "string-splitting", main: "docs-main-string.ts", root: layoutDir, splitting: true },
  { name: "url-inline", main: "docs-main-url-inline.ts", root: layoutDir, splitting: false },
  { name: "url-variable", main: "docs-main-url-variable.ts", root: layoutDir, splitting: false },
  { name: "url-variable-conditions", main: "docs-main-url-variable.ts", root: layoutDir, splitting: false, conditions: ["bun", "node"] },
  { name: "href", main: "docs-main-href.ts", root: layoutDir, splitting: false },
]

const outDir = join(workRoot(), "probe", `docs-layout-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type Result = Record<string, unknown>
const results: Result[] = []
for (const variant of variants) {
  const entry = join(layoutDir, variant.main)
  const outfile = join(outDir, `${variant.name}${exeSuffix}`)
  const build = await Bun.build({
    ...(variant.root ? { root: variant.root } : {}),
    ...(variant.conditions ? { conditions: variant.conditions } : {}),
    entrypoints: [entry, workerEntry],
    minify: true,
    splitting: variant.splitting,
    compile: { target: targetName() as never, outfile },
  })
  if (!build.success) {
    results.push({
      variant: variant.name,
      root: variant.root ?? "(default)",
      splitting: variant.splitting,
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
    variant: variant.name,
    root: variant.root ?? "(default)",
    splitting: variant.splitting,
    conditions: variant.conditions ?? [],
    buildSuccess: true,
    exitCode: code,
    stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    stderrTail: stderr.trim().split("\n").slice(-4).join("\n"),
    binarySha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  })
}

console.log(JSON.stringify({ probe: "docs-layout-matrix", bunVersion: process.versions.bun, outDir, results }, null, 2))
if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
