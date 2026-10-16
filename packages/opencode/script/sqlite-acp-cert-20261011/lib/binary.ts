/// <reference types="bun" />
// Exact packaged-binary resolution. Either consume an explicitly provided
// binary (verified, hashed, never rebuilt) or run the repository packaging
// pipeline into a unique disposable output directory with all repo-mutating
// side channels disabled:
//   --skip-install            -> no bun install / lockfile change
//   --skip-embed-web-ui       -> no packages/app/dist build
//   MODELS_DEV_API_JSON       -> no models.dev fetch and no .cache write
//   OPENFORK_BUILD_OUTPUT_DIR -> all dist writes redirected out of the repo
//   OPENCODE_TEST_HOME        -> build's own binary smoke logs land in temp
// A caller-supplied outputDir is used verbatim; otherwise a unique temp dir is
// created under the OS temp root.

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { errorRecord, nowIso } from "./report"
import { workRoot } from "./work"

export type BinaryInfo = {
  path: string
  sha256: string
  bytes: number
  version: string
  source: "provided" | "built"
  buildCommand?: string
  buildMs?: number
  buildOutputDir?: string
  buildLogTail?: string
  builtAt?: string
  buildFailure?: string
}

const packageRoot = resolve(import.meta.dir, "..", "..", "..")

async function sha256File(path: string): Promise<string> {
      const handle = await open(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

async function binaryVersion(path: string, cwd: string): Promise<string> {
  const child = Bun.spawn([path, "--version"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`binary --version exited ${code}: ${stderr.slice(0, 1000)}`)
  return stdout.trim()
}

export async function describeBinary(path: string): Promise<BinaryInfo> {
  const absolute = resolve(path)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`binary path is not a file: ${absolute}`)
  return {
    path: absolute,
    sha256: await sha256File(absolute),
    bytes: info.size,
    version: await binaryVersion(absolute, resolve(absolute, "..")),
    source: "provided",
  }
}

async function findBuiltBinary(outputDir: string): Promise<string> {
  const candidates = [
    join(outputDir, "openfork-windows-x64", "bin", "openfork.exe"),
    join(outputDir, "openfork-linux-x64", "bin", "openfork"),
    join(outputDir, "openfork-darwin-arm64", "bin", "openfork"),
    join(outputDir, "openfork-darwin-x64", "bin", "openfork"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  for (const entry of await readdir(outputDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    for (const name of ["openfork.exe", "openfork"]) {
      const candidate = join(outputDir, entry.name, "bin", name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`no packaged executable found under ${outputDir}`)
}

export async function buildPackagedBinary(options: {
  outputDir: string
  timeoutMs: number
  log: (line: string) => void
}): Promise<BinaryInfo> {
  const started = performance.now()
  await mkdir(options.outputDir, { recursive: true })
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.OPENFORK_BUILD_OUTPUT_DIR = options.outputDir
  env.OPENCODE_TEST_HOME = join(options.outputDir, "build-home")
  await mkdir(env.OPENCODE_TEST_HOME, { recursive: true })
  const modelsCache = join(packageRoot, ".cache", "models.dev.json")
  let modelsSource = "unset"
  if (existsSync(modelsCache)) {
    env.MODELS_DEV_API_JSON = modelsCache
    modelsSource = modelsCache
  }
  const command = ["bun", "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"]
  options.log(`build: ${command.join(" ")}`)
  options.log(`build output: ${options.outputDir}`)
  options.log(`models source: ${modelsSource}`)
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error(`packaging pipeline exceeded ${options.timeoutMs}ms`))
    }, options.timeoutMs)
  })
  let code: number
  try {
    code = await Promise.race([child.exited, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  const [out, err] = await Promise.all([stdout, stderr])
  const logTail = (out + "\n" + err).split("\n").filter((line) => line.trim()).slice(-40).join("\n")
  options.log(`build exit: ${code} in ${Math.round(performance.now() - started)}ms`)
  if (code !== 0) {
    // The packaging pipeline can fail its own embedded smoke after writing a
    // valid binary (for example the known packaged-worker gate). Surface that
    // failure without hiding the artifact: callers characterize the binary.
    const produced = await findBuiltBinary(options.outputDir).catch(() => undefined)
    if (!produced) throw new Error(`packaging pipeline exited ${code}\n${logTail}`)
    return {
      path: resolve(produced),
      sha256: await sha256File(produced),
      bytes: (await stat(produced)).size,
      version: await binaryVersion(produced, options.outputDir),
      source: "built",
      buildCommand: command.join(" "),
      buildMs: Math.round(performance.now() - started),
      buildOutputDir: options.outputDir,
      buildLogTail: logTail,
      builtAt: nowIso(),
      buildFailure: `packaging pipeline exited ${code} after writing the binary:\n${logTail}`,
    }
  }
  const binary = await findBuiltBinary(options.outputDir)
  return {
    path: resolve(binary),
    sha256: await sha256File(binary),
    bytes: (await stat(binary)).size,
    version: await binaryVersion(binary, options.outputDir),
    source: "built",
    buildCommand: command.join(" "),
    buildMs: Math.round(performance.now() - started),
    buildOutputDir: options.outputDir,
    buildLogTail: logTail,
    builtAt: nowIso(),
  }
}

export function defaultOutputDir(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
  return join(workRoot(), "builds", `${label}-${stamp}-${process.pid}`)
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export { errorRecord }
