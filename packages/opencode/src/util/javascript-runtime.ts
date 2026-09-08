import fs from "node:fs"
import path from "node:path"

export type JavaScriptRuntimeKind = "bun" | "node" | "electron"

export type JavaScriptRuntimeInfo = {
  kind: JavaScriptRuntimeKind
  execPath: string
  standalone: boolean
  script: {
    command: string
    args: string[]
    env: Record<string, string>
  }
}

type RuntimeProbe = {
  execPath?: string
  versions?: { electron?: string }
  argv?: string[]
  bunMain?: string
  bun?: {
    isStandaloneExecutable?: boolean
  } | null
}

const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])

function normalizeRuntimePath(value: string) {
  return value.replaceAll("\\", "/")
}

function isBunStandalone(probe: RuntimeProbe, bun: { isStandaloneExecutable?: boolean } | undefined) {
  if (!bun) return false
  if (bun.isStandaloneExecutable === true) return true

  // Bun 1.3.x does not expose `Bun.isStandaloneExecutable`, but compiled
  // executables have a stable runtime signature: argv[0] is the literal `bun`
  // and Bun.main / argv[1] lives inside Bun's virtual filesystem. Keep these
  // roots aligned with script/build.ts.
  const argv = probe.argv ?? process.argv
  let main = probe.bunMain
  if (main === undefined && typeof Bun !== "undefined") {
    const value = Reflect.get(Bun, "main")
    if (typeof value === "string") main = value
  }
  if (!main) main = argv[1] ?? ""

  const normalized = normalizeRuntimePath(main)
  const virtualMain = normalized.startsWith("B:/~BUN/root/") || normalized.startsWith("/$bunfs/root/")
  return argv[0] === "bun" && virtualMain
}

export function javascriptRuntime(probe: RuntimeProbe = {}): JavaScriptRuntimeInfo {
  const execPath = probe.execPath ?? process.execPath
  const versions = probe.versions ?? process.versions
  const actualBun =
    typeof Bun === "undefined"
      ? undefined
      : {
          isStandaloneExecutable: Reflect.get(Bun, "isStandaloneExecutable") === true,
        }
  const bun = probe.bun === undefined ? actualBun : (probe.bun ?? undefined)

  if (versions.electron) {
    return {
      kind: "electron",
      execPath,
      standalone: false,
      script: {
        command: execPath,
        args: [],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    }
  }

  if (bun) {
    const standalone = isBunStandalone(probe, bun)
    return {
      kind: "bun",
      execPath,
      standalone,
      script: {
        command: execPath,
        args: [],
        env: standalone ? { BUN_BE_BUN: "1" } : {},
      },
    }
  }

  return {
    kind: "node",
    execPath,
    standalone: false,
    script: {
      command: execPath,
      args: [],
      env: {},
    },
  }
}

type NestedScriptProbe = {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  pid?: number
  runtime?: JavaScriptRuntimeInfo
  isFile?: (file: string) => boolean
}

export type NestedScriptRequest = {
  file: string
  args: string[]
}

export function userChildEnvironment(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...base, ...overrides }

  // ELECTRON_RUN_AS_NODE is an OpenCode host-runtime compatibility flag, not a
  // user-shell setting. Do not leak it into arbitrary shell commands such as
  // `electron .`; a shell.env plugin may still opt in explicitly.
  if (!Object.hasOwn(overrides, "ELECTRON_RUN_AS_NODE")) delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function nestedStandaloneScriptRequest(probe: NestedScriptProbe = {}): NestedScriptRequest | undefined {
  const runtime = probe.runtime ?? javascriptRuntime()
  if (runtime.kind !== "bun" || !runtime.standalone) return undefined

  const env = probe.env ?? process.env
  if (env.BUN_BE_BUN === "1") return undefined
  if (env.OPENCODE !== "1") return undefined

  const pid = probe.pid ?? process.pid
  const inheritedPid = Number.parseInt(env.OPENCODE_PID ?? "", 10)
  if (!Number.isFinite(inheritedPid) || inheritedPid <= 0 || inheritedPid === pid) return undefined

  const argv = probe.argv ?? process.argv.slice(2)
  const candidate = argv[0]
  if (!candidate || candidate.startsWith("-")) return undefined
  if (!SCRIPT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return undefined

  const file = path.resolve(probe.cwd ?? process.cwd(), candidate)
  const isFile =
    probe.isFile ??
    ((value: string) => {
      try {
        return fs.statSync(value).isFile()
      } catch {
        return false
      }
    })
  if (!isFile(file)) return undefined

  return { file, args: argv.slice(1) }
}

export async function rerouteNestedStandaloneScript(): Promise<number | undefined> {
  const request = nestedStandaloneScriptRequest()
  if (!request) return undefined

  const runtime = javascriptRuntime()
  try {
    const child = Bun.spawn([runtime.script.command, ...runtime.script.args, request.file, ...request.args], {
      env: {
        ...process.env,
        ...runtime.script.env,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    return await child.exited
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[opencode] failed to reroute nested JavaScript launch: ${message}\n`)
    return 1
  }
}
