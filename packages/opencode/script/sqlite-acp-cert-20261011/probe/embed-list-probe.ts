// Compile embed-list.ts with a nested worker entrypoint at several roots and
// print what the app-mode virtual filesystem actually contains.

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const bisectDir = join(import.meta.dir, "bisect")
const workerEntry = join(bisectDir, "sqlite-bun-worker.ts")
const mainEntry = join(import.meta.dir, "embed-list.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  return "bun-linux-x64"
}

const outDir = join(workRoot(), "probe", `embed-list-${Date.now()}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const cases: { name: string; root?: string; files?: Record<string, string> }[] = [
  { name: "root-probe", root: resolve(bisectDir, "..") },
  { name: "root-bisect", root: bisectDir },
  { name: "root-default" },
  {
    name: "root-probe-files",
    root: resolve(bisectDir, ".."),
    files: { "sqlite-bun-worker.ts": "console.log('materialized')\n" },
  },
]

for (const item of cases) {
  const outfile = join(outDir, `${item.name}.exe`)
  const build = await Bun.build({
    ...(item.root ? { root: item.root } : {}),
    ...(item.files ? { files: item.files } : {}),
    entrypoints: [mainEntry, workerEntry],
    minify: false,
    splitting: false,
    compile: { target: targetName() as never, outfile },
  })
  if (!build.success) {
    console.log(JSON.stringify({ case: item.name, buildSuccess: false, logs: build.logs.map((l) => l.message) }))
    continue
  }
  const child = Bun.spawn([outfile], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  console.log(JSON.stringify({ case: item.name, root: item.root ?? "(default)", code, stdout: stdout.trim().slice(0, 4000), stderr: stderr.trim().slice(0, 500) }))
}

if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
