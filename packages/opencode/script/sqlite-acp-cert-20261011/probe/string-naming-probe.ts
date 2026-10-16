// Compile string-worker-main.ts with a basename-named worker entry and run the
// TUI-style string Worker launch for both ".js" and ".ts" specifiers.

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const probeDir = import.meta.dir
const workerEntry = join(probeDir, "cross-layout", "worker.ts")
const mainEntry = join(probeDir, "string-worker-main.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  return "bun-linux-x64"
}

const outDir = join(workRoot(), "probe", `string-naming-${Date.now()}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const outfile = join(outDir, "string-naming.exe")
const build = await Bun.build({
  root: probeDir,
  entrypoints: [mainEntry, workerEntry],
  minify: true,
  splitting: false,
  naming: { entry: "[name].[ext]" },
  compile: { target: targetName() as never, outfile },
})
if (!build.success) {
  console.log(JSON.stringify({ buildSuccess: false, logs: build.logs.map((l) => l.message) }))
  process.exit(1)
}

for (const spec of ["./worker.js", "./worker.ts", "worker.js"]) {
  const child = Bun.spawn([outfile, spec], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  console.log(JSON.stringify({ spec, code, stdout: stdout.trim(), stderr: stderr.trim().slice(0, 300) }))
}

if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
