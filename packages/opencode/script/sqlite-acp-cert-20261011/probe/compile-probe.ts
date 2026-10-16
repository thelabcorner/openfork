// Compile-matrix driver: proves whether the packaged worker failure is caused by
// the `splitting: true` build setting (embedding/URL resolution) or by the
// worker's native SQLite open, or by nothing at all (environment/fixture).
//
// Variants:
//   source   - run the probe in Bun source mode (control)
//   split    - compile with splitting:true    (mimics script/build.ts)
//   nosplit  - compile with splitting:false   (mimics the core standalone test)
//
// Usage:
//   bun run probe/compile-probe.ts [--variants source,split,nosplit] [--keep]
//
// All outputs are disposable and live under this lane's .work directory.

import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { workRoot } from "../lib/work"

const laneRoot = resolve(import.meta.dir, "..")
const packageRoot = resolve(laneRoot, "..", "..")
const probeEntry = join(import.meta.dir, "worker-probe.ts")
const workerEntry = resolve(packageRoot, "..", "core", "src", "database", "sqlite-bun-worker.ts")

function targetName(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  if (process.platform === "darwin") return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

function exeName(): string {
  return process.platform === "win32" ? "probe.exe" : "probe"
}

type VariantResult = {
  variant: string
  binary?: string
  binaryBytes?: number
  binarySha256?: string
  buildMs?: number
  buildSuccess?: boolean
  buildLogs?: string[]
  exitCode?: number
  stdout?: string[]
  stderrTail?: string
  elapsedMs?: number
  error?: string
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash("sha256").update(bytes).digest("hex")
}

async function runProbe(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<Omit<VariantResult, "variant">> {
  const started = performance.now()
  const child = Bun.spawn([binary, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error(`probe run exceeded ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const code = await Promise.race([child.exited, timeout])
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return {
      exitCode: code,
      stdout: stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      stderrTail: stderr.trim().split("\n").slice(-10).join("\n"),
      elapsedMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    return { error: String(error), elapsedMs: Math.round(performance.now() - started) }
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) {
      try {
        child.kill()
      } catch {}
    }
  }
}

async function compileVariant(variant: "split" | "nosplit", outDir: string, dbPath: string): Promise<VariantResult> {
  const outfile = join(outDir, `${variant}-${exeName()}`)
  const started = performance.now()
  const build = await Bun.build({
    conditions: ["bun", "node"],
    entrypoints: [probeEntry, workerEntry],
    minify: true,
    splitting: variant === "split",
    compile: { target: targetName() as never, outfile },
  })
  const buildMs = Math.round(performance.now() - started)
  if (!build.success) {
    return {
      variant,
      buildSuccess: false,
      buildMs,
      buildLogs: build.logs.map((log) => `${log.level}: ${log.message}`).slice(0, 20),
    }
  }
  const result = await runProbe(outfile, [dbPath], outDir, 60_000)
  return {
    variant,
    buildSuccess: true,
    buildMs,
    binary: outfile,
    binaryBytes: (await stat(outfile)).size,
    binarySha256: await sha256(outfile),
    ...result,
  }
}

const variantsArg = (() => {
  const index = process.argv.indexOf("--variants")
  if (index < 0) return ["source", "split", "nosplit"]
  const value = process.argv[index + 1]
  if (!value) throw new Error("--variants requires a comma-separated list")
  return value.split(",").map((item) => item.trim())
})()
const keep = process.argv.includes("--keep")

const outDir = join(workRoot(), "probe", `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`)
await mkdir(outDir, { recursive: true })

const results: VariantResult[] = []
for (const variant of variantsArg) {
  const dbPath = join(outDir, `${variant}.sqlite`)
  if (variant === "source") {
    const result = await runProbe("bun", ["run", probeEntry, dbPath], outDir, 60_000)
    results.push({ variant, ...result })
  } else if (variant === "split" || variant === "nosplit") {
    results.push(await compileVariant(variant, outDir, dbPath))
  } else {
    results.push({ variant, error: `unknown variant ${variant}` })
  }
}

const report = {
  probe: "compile-matrix",
  platform: process.platform,
  arch: process.arch,
  bunVersion: process.versions.bun,
  probeEntry,
  workerEntry,
  outDir,
  results,
}
console.log(JSON.stringify(report, null, 2))
if (!keep) await rm(outDir, { recursive: true, force: true }).catch(() => {})
