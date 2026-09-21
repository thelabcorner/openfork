export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200

// cmd.exe documents an 8191-character ceiling. Keep headroom rather than
// treating the published maximum as a usable payload budget.
export const CMD_INLINE_SCRIPT_LIMIT = 8_000
export const CMD_INHERITED_ENV_LIMIT = 8_191
// Windows process command lines are bounded at 32,767 UTF-16 code units.
// Empirically, direct PowerShell argv remains healthy at ~32k and fails near
// 32.7k once executable/flag overhead is included. Keep headroom on the fast
// path, then switch to the environment-backed source transport below.
export const POWERSHELL_INLINE_SCRIPT_LIMIT = 30_000
export const POWERSHELL_AUTOMATION_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const
export const MSYS_SCRIPT_SOURCE_ENV = "OPENCODE_INTERNAL_SHELL_SOURCE"
const MSYS_SCRIPT_SOURCE_VAR = "__opencode_internal_shell_source_4f73b6a1"
const MSYS_ENV_CONV_EXCL = "MSYS2_ENV_CONV_EXCL"
export const POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT = 24_000
export const POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX = "OPENCODE_INTERNAL_POWERSHELL_SOURCE_4F73B6A1_"
export const MSYS_SCRIPT_CAPTURE = [
  '__opencode_internal_shell_source_4f73b6a1="$OPENCODE_INTERNAL_SHELL_SOURCE"',
  "unset OPENCODE_INTERNAL_SHELL_SOURCE",
  'case "$MSYS2_ENV_CONV_EXCL" in',
  '  "OPENCODE_INTERNAL_SHELL_SOURCE") unset MSYS2_ENV_CONV_EXCL ;;',
  '  *";OPENCODE_INTERNAL_SHELL_SOURCE") MSYS2_ENV_CONV_EXCL="${MSYS2_ENV_CONV_EXCL%;OPENCODE_INTERNAL_SHELL_SOURCE}"; export MSYS2_ENV_CONV_EXCL ;;',
  "esac",
].join("\n")
export const MSYS_SCRIPT_EVAL = 'eval "$__opencode_internal_shell_source_4f73b6a1"'
export const MSYS_SCRIPT_BOOTSTRAP = [MSYS_SCRIPT_CAPTURE, MSYS_SCRIPT_EVAL].join("\n")

export type SourceEnvironmentEntry = {
  key: string
  value: string
}

export type SourceEnvironment = {
  entries: readonly SourceEnvironmentEntry[]
  clearPrefixes?: readonly string[]
  msysExclusions?: readonly string[]
}

export type Invocation = {
  command?: string
  args: string[]
  shell?: string
  sourceEnvironment?: SourceEnvironment
}

function rejectNul(command: string) {
  if (!command.includes("\0")) return
  throw new Error("Shell script source cannot contain a NUL byte.")
}

/**
 * cmd.exe silently ignores inherited environment values above its 8191-character
 * limit when authored source expands them with %NAME% syntax. Detect only the
 * variables the single-line command actually references; oversized values that
 * are merely inherited by a native child remain valid and must not be rejected.
 */
function validateCmdEnvironment(file: string, command: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32" || name(file) !== "cmd") return
  const oversized = new Map<string, { key: string; length: number }>()
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase()
    // An uncanonicalized Windows environment map can contain differently-cased
    // duplicates. CreateProcess/cmd observes the first logical entry, so the
    // defense-in-depth validator must make the same decision.
    if (seen.has(lower)) continue
    seen.add(lower)
    if (value === undefined || value.length <= CMD_INHERITED_ENV_LIMIT) continue
    oversized.set(lower, { key, length: value.length })
  }
  if (oversized.size === 0) return

  for (const match of command.matchAll(/%([^%\r\n]+)%/g)) {
    const expression = match[1]
    if (!expression) continue
    // cmd supports modifiers such as %VAR:~0,10% and %VAR:a=b%; the
    // environment-variable name precedes the first colon in those forms.
    const key = expression.split(":", 1)[0]?.toLowerCase()
    if (!key) continue
    const item = oversized.get(key)
    if (!item) continue
    throw new Error(
      `Cannot execute this cmd.exe script faithfully because it expands inherited environment variable "${item.key}", whose value is ${item.length} characters. cmd.exe ignores inherited variables longer than ${CMD_INHERITED_ENV_LIMIT} characters during %VAR% expansion. Pass the data through a file/stdin interface or shorten that environment value before using cmd.exe.`,
    )
  }
}

/**
 * Validate shell-specific environment semantics at the final process boundary.
 * Callers should use this generic owner rather than learning individual shell
 * quirks. Today only cmd.exe needs an environment/source cross-check; future
 * interpreter-specific invariants belong here as well.
 */
export function validateInvocationEnvironment(file: string, command: string, env: NodeJS.ProcessEnv) {
  validateCmdEnvironment(file, command, env)
}

export function msysScriptTransport(command: string) {
  rejectNul(command)
  return {
    script: MSYS_SCRIPT_BOOTSTRAP,
    sourceEnvironment: {
      entries: [{ key: MSYS_SCRIPT_SOURCE_ENV, value: command }],
      msysExclusions: [MSYS_SCRIPT_SOURCE_ENV],
    } satisfies SourceEnvironment,
  }
}

function splitSource(command: string, limit: number) {
  const chunks: string[] = []
  for (let start = 0; start < command.length; ) {
    let end = Math.min(start + limit, command.length)
    if (end < command.length) {
      const before = command.charCodeAt(end - 1)
      const after = command.charCodeAt(end)
      // JavaScript strings and the Windows environment are UTF-16. Never cut a
      // surrogate pair between environment entries or source reconstruction
      // would manufacture two replacement characters before PowerShell parses it.
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--
    }
    chunks.push(command.slice(start, end))
    start = end
  }
  if (chunks.length === 0) chunks.push("")
  return chunks
}

export function powershellScriptTransport(command: string) {
  rejectNul(command)
  const entries = splitSource(command, POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT).map((value, index) => ({
    key: POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX + String(index).padStart(4, "0"),
    value,
  }))
  const count = entries.length
  const length = command.length
  // Reconstruct in a child scope so transport variables are gone before the
  // authored program runs. Invoke-Expression itself remains at the outer scope,
  // matching direct `-Command` scope semantics. Remove each environment entry
  // through PowerShell's Env: provider before source execution; pwsh 7 can keep
  // provider-visible state if only the .NET environment API is used to clear it.
  // Fail closed if a chunk is missing or the reconstructed UTF-16 length differs
  // from the launch plan. Without this guard, String.Concat treats a missing
  // environment value as empty and can silently execute a shorter valid program.
  const script = [
    "Invoke-Expression (& {",
    `  $__opencode_internal_shell_parts_4f73b6a1 = New-Object 'string[]' ${count}`,
    `  for ($__opencode_internal_shell_index_4f73b6a1 = 0; $__opencode_internal_shell_index_4f73b6a1 -lt ${count}; $__opencode_internal_shell_index_4f73b6a1++) {`,
    `    $__opencode_internal_shell_key_4f73b6a1 = '${POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX}' + $__opencode_internal_shell_index_4f73b6a1.ToString('D4')`,
    "    if (-not (Test-Path -LiteralPath ('Env:' + $__opencode_internal_shell_key_4f73b6a1))) {",
    `      throw ('OpenFork PowerShell source transport is incomplete: missing chunk ' + $__opencode_internal_shell_index_4f73b6a1 + ' of ${count}.')`,
    "    }",
    "    $__opencode_internal_shell_parts_4f73b6a1[$__opencode_internal_shell_index_4f73b6a1] = [Environment]::GetEnvironmentVariable($__opencode_internal_shell_key_4f73b6a1, 'Process')",
    "    Remove-Item -LiteralPath ('Env:' + $__opencode_internal_shell_key_4f73b6a1) -ErrorAction SilentlyContinue",
    "  }",
    "  $__opencode_internal_shell_source_4f73b6a1 = [String]::Concat($__opencode_internal_shell_parts_4f73b6a1)",
    `  if ($__opencode_internal_shell_source_4f73b6a1.Length -ne ${length}) { throw ('OpenFork PowerShell source transport length mismatch: expected ${length}, received ' + $__opencode_internal_shell_source_4f73b6a1.Length + '.') }`,
    "  $__opencode_internal_shell_source_4f73b6a1",
    "})",
  ].join("\n")
  return {
    script,
    sourceEnvironment: {
      entries,
      clearPrefixes: [POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX],
    } satisfies SourceEnvironment,
  }
}

function msysEnvironmentExclusion(current: string | undefined, key: string) {
  // Always append our key unless `*` already disables all conversion. The
  // bootstrap removes exactly one trailing copy before user source executes,
  // which restores the caller value even when it already contained this key.
  if (current === "*") return current
  if (current === undefined) return key
  // Preserve the distinction between an unset policy and an explicitly empty
  // policy. `;KEY` is stripped back to the empty string by the bootstrap,
  // whereas bare `KEY` is stripped by unsetting the variable.
  return `${current};${key}`
}

function windowsEnvironmentValue(env: NodeJS.ProcessEnv | undefined, key: string) {
  if (!env) return
  const exact = env[key]
  if (exact !== undefined) return exact
  const target = key.toLowerCase()
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === target && value !== undefined) return value
  }
}

export function withSourceEnvironment(
  base: NodeJS.ProcessEnv,
  source: SourceEnvironment | undefined,
  inherited?: NodeJS.ProcessEnv,
) {
  if (!source) return base
  // Windows environment names are case-insensitive, while JavaScript object
  // keys are not. Canonicalize transport-owned names in one pass so a
  // differently-cased caller entry cannot race the value that reaches
  // CreateProcess. Large PowerShell source may span several private entries;
  // stale entries from the reserved prefix are removed at the same boundary.
  const sourceKeys = new Set(source.entries.map((entry) => entry.key.toLowerCase()))
  const clearPrefixes = (source.clearPrefixes ?? []).map((prefix) => prefix.toLowerCase())
  const msysExclusions = source.msysExclusions ?? []
  const hasMsysExclusions = msysExclusions.length > 0
  const exclusionKey = MSYS_ENV_CONV_EXCL.toLowerCase()
  let current: string | undefined
  let sawCurrent = false
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    const lower = name.toLowerCase()
    if (sourceKeys.has(lower) || clearPrefixes.some((prefix) => lower.startsWith(prefix))) continue
    if (hasMsysExclusions && lower === exclusionKey) {
      // Match ordinary object/env override semantics: when the caller supplied
      // the same logical Windows key with different casing, the later entry
      // wins. This matters for plugin/user env maps layered over process.env.
      current = value
      sawCurrent = true
      continue
    }
    out[name] = value
  }
  if (hasMsysExclusions && !sawCurrent) {
    const inheritedValue = windowsEnvironmentValue(inherited, MSYS_ENV_CONV_EXCL)
    if (inheritedValue !== undefined) {
      current = inheritedValue
      sawCurrent = true
    }
  }
  for (const entry of source.entries) out[entry.key] = entry.value
  if (hasMsysExclusions) {
    // MSYS2 converts path-looking environment values by default. Source is
    // opaque data, never a path list, so exclude only transport-owned keys while
    // preserving the caller's exact prior policy (including an empty string).
    let policy = sawCurrent ? current : undefined
    for (const key of msysExclusions) policy = msysEnvironmentExclusion(policy, key)
    out[MSYS_ENV_CONV_EXCL] = policy
  }
  return out
}
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function invocation(file: string, command: string, cwd: string): Invocation {
  rejectNul(command)
  const n = name(file)
  if (process.platform === "win32" && n === "cmd" && command.length > CMD_INLINE_SCRIPT_LIMIT) {
    throw new Error(
      `Cannot execute this inline cmd.exe script safely above ${CMD_INLINE_SCRIPT_LIMIT} characters on Windows. Use a temporary script/body file and run a short command that references it.`,
    )
  }
  if (process.platform === "win32" && n === "cmd" && /[\r\n]/.test(command)) {
    throw new Error(
      "Cannot execute a multiline cmd.exe program through the inline command transport because cmd.exe can silently execute only a prefix. Put the program in a temporary .cmd file or use explicit chain operators for a short sequence.",
    )
  }
  if (n === "nu" || n === "fish") return { args: ["-c", command] }
  const msys = process.platform === "win32" && posix(file) ? msysScriptTransport(command) : undefined
  if (n === "zsh") {
    if (msys) {
      return {
        args: [
          "-l",
          "-c",
          `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        ${msys.script}
      `,
          "opencode",
          cwd,
        ],
        sourceEnvironment: msys.sourceEnvironment,
      }
    }
    return {
      args: [
        "-l",
        "-c",
        `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        # Keep command source out of this bootstrap's parse, then restore the
        # historical command-visible positional parameters before eval.
        __opencode_session_shell_source=$2
        set -- "$1"
        eval "$__opencode_session_shell_source"
      `,
        "opencode",
        cwd,
        command,
      ],
    }
  }
  if (n === "bash") {
    if (msys) {
      return {
        args: [
          "-l",
          "-c",
          `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        ${msys.script}
      `,
          "opencode",
          cwd,
        ],
        sourceEnvironment: msys.sourceEnvironment,
      }
    }
    return {
      args: [
        "-l",
        "-c",
        `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        # Keep command source out of this bootstrap's parse, then restore the
        # historical command-visible positional parameters before eval.
        __opencode_session_shell_source=$2
        set -- "$1"
        eval "$__opencode_session_shell_source"
      `,
        "opencode",
        cwd,
        command,
      ],
    }
  }
  // Node's documented cmd shell adapter owns the Windows command-line
  // serialization and enables windowsVerbatimArguments for cmd.exe. Passing
  // the authored script as the final argv element ourselves lets the generic
  // Win32 argv serializer preserve wrapper quotes as literal data.
  if (n === "cmd") return { command, args: [], shell: file }
  if (ps(file)) {
    if (process.platform === "win32" && command.length > POWERSHELL_INLINE_SCRIPT_LIMIT) {
      const transport = powershellScriptTransport(command)
      return {
        args: [...POWERSHELL_AUTOMATION_ARGS, transport.script],
        sourceEnvironment: transport.sourceEnvironment,
      }
    }
    return { args: [...POWERSHELL_AUTOMATION_ARGS, command] }
  }
  if (msys) return { args: ["-c", msys.script], sourceEnvironment: msys.sourceEnvironment }
  return { args: ["-c", command] }
}

/**
 * Compatibility accessor for callers that can represent an invocation as argv
 * alone. Fail closed when doing so would discard a shell adapter or private
 * source-environment transport; new execution code should use `invocation()`.
 */
export function args(file: string, command: string, cwd: string) {
  const value = invocation(file, command, cwd)
  if (value.command !== undefined || value.shell !== undefined || value.sourceEnvironment !== undefined) {
    throw new Error("Shell.args() cannot represent this shell invocation without losing transport metadata; use Shell.invocation().")
  }
  return value.args
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}
