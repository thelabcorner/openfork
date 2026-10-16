// Relative-entrypoint root behavior. build.ts passes relative entrypoints with
// cwd = packages/opencode (one of them `../core/...`, escaping cwd). This probe
// maps how Bun 1.4.3 names embedded additional entrypoints for that shape.

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneDir = resolve(import.meta.dir, "..")
const probeDir = import.meta.dir
const bisectDir = join(probeDir, "bisect")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  return "bun-linux-x64"
}

const outDir = join(workRoot(), "probe", `relative-${Date.now()}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const cases: { name: string; cwd: string; entrypoints: string[] }[] = [
  { name: "rel-lane", cwd: laneDir, entrypoints: ["./probe/embed-list.ts", "./probe/bisect/sqlite-bun-worker.ts"] },
  { name: "rel-probe", cwd: probeDir, entrypoints: ["./embed-list.ts", "./bisect/sqlite-bun-worker.ts"] },
  {
    name: "rel-escape",
    cwd: bisectDir,
    entrypoints: ["../embed-list.ts", "./sqlite-bun-worker.ts"],
  },
]

const originalCwd = process.cwd()
for (const item of cases) {
  process.chdir(item.cwd)
  const outfile = join(outDir, `${item.name}.exe`)
  try {
    const build = await Bun.build({
      entrypoints: item.entrypoints,
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
    let embedded: unknown = undefined
    try {
      embedded = (JSON.parse(stdout.trim()) as Record<string, unknown>)["B:/~BUN/root"]
    } catch {}
    console.log(
      JSON.stringify({
        case: item.name,
        cwd: item.cwd,
        entrypoints: item.entrypoints,
        code,
        embedded,
        stdoutFull: stdout.trim().slice(0, 2500),
        stderr: stderr.trim().slice(0, 300),
      }),
    )
  } finally {
    process.chdir(originalCwd)
  }
}

if (!process.argv.includes("--keep")) await rm(outDir, { recursive: true, force: true }).catch(() => {})
