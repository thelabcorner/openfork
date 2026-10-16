// Outputs introspection: what does Bun.build report (paths/sizes/kinds) for the
// failing production client pair vs the passing minimal pair? Read-only build
// introspection; artifacts land under .work.

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneDir, "..", "..")
const packagesDir = resolve(packageRoot, "..")
const workerEntry = join(packagesDir, "core", "src", "database", "sqlite-bun-worker.ts")
const minimalMain = join(import.meta.dir, "cross-layout", "main-host-variable-same-dir.ts")
const minimalWorker = join(import.meta.dir, "cross-layout", "worker.ts")
const productionMain = join(import.meta.dir, "worker-probe.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const outDir = join(workRoot(), "probe", `outputs-${Date.now()}-${process.pid}`)
await mkdir(outDir, { recursive: true })

type CaseResult = {
  name: string
  success: boolean
  logs: string[]
  outputs: { path: string; kind: string; bytes: number }[]
}

const cases = [
  { name: "minimal", entrypoints: [minimalMain, minimalWorker] as string[], main: minimalMain },
  { name: "production", entrypoints: [productionMain, workerEntry] as string[], main: productionMain },
  {
    name: "production-repo-root",
    entrypoints: [productionMain, workerEntry] as string[],
    main: productionMain,
    root: resolve(packagesDir, ".."),
  },
]

const results: CaseResult[] = []
for (const item of cases) {
  const outfile = join(outDir, `${item.name}.exe`)
  const build = await Bun.build({
    ...(item.root ? { root: item.root } : {}),
    entrypoints: item.entrypoints,
    minify: true,
    splitting: false,
    compile: { target: targetName() as never, outfile },
  })
  const outputs: CaseResult["outputs"] = []
  for (const output of build.outputs) {
    outputs.push({
      path: output.path,
      kind: output.kind,
      bytes: (await output.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength,
    })
  }
  results.push({
    name: item.name,
    success: build.success,
    logs: build.logs.map((log) => `${log.level}: ${log.message}`).slice(0, 10),
    outputs,
  })
}

console.log(JSON.stringify({ probe: "outputs-introspection", bunVersion: process.versions.bun, results }, null, 2))
await rm(outDir, { recursive: true, force: true }).catch(() => {})
