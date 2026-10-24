// Real-build layout mirror: cwd = packages/opencode, relative entrypoints, one
// nested in-cwd worker (stand-in for ./src/cli/tui/worker.ts) and the real
// out-of-cwd sqlite worker (../core/...). Prints the embedded FS listing so the
// owner-ready naming fix can be scoped against actual runtime paths.

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const packageRoot = resolve(import.meta.dir, "..", "..", "..")
const laneRel = "./script/sqlite-acp-cert-20261011/probe"
const entries = [
  `${laneRel}/embed-list.ts`,
  `${laneRel}/cross-layout/worker.ts`,
  "../core/src/database/sqlite-bun-worker.ts",
].map((entry) => resolve(packageRoot, entry))

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  return "bun-linux-x64"
}

const outDir = join(workRoot(), "probe", `real-layout-${Date.now()}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const originalCwd = process.cwd()
for (const naming of [false, true]) {
  const outfile = join(outDir, `layout-${naming ? "naming" : "default"}.exe`)
  try {
    const build = await Bun.build({
      root: packageRoot,
      ...(naming ? { naming: { entry: "[name].[ext]" } } : {}),
      entrypoints: entries,
      minify: false,
      splitting: false,
      compile: { target: targetName() as never, outfile },
    })
    if (!build.success) {
      console.log(JSON.stringify({ naming, buildSuccess: false, logs: build.logs.map((l) => l.message).slice(0, 5) }))
      continue
    }
    const child = Bun.spawn([outfile], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    let listing: unknown = undefined
    let probes: unknown = undefined
    try {
      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
      listing = parsed["B:/~BUN/root"]
      probes = {
        sqliteWorkerTs: parsed["B:/~BUN/root/sqlite-bun-worker.ts"],
        sqliteWorkerJs: parsed["B:/~BUN/root/sqlite-bun-worker.js"],
      }
    } catch {}
    console.log(JSON.stringify({ naming, code, listing, probes, stderr: stderr.trim().slice(0, 300) }))
  } finally {
    process.chdir(originalCwd)
  }
}

if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
