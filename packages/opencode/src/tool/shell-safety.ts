import path from "node:path"

export type ShellSafetyKind = "bash" | "powershell" | "cmd"

export type ShellSafetyOptions = {
  kind: ShellSafetyKind
  home: string
  cwd: string
}

const BLOCK_MESSAGE =
  "Blocked catastrophic recursive delete: target resolves to a filesystem root or the user-home root. Narrow the target and retry."

const POSIX_WRAPPERS = new Set(["command", "builtin", "nohup"])
const POWERSHELL_DELETE = new Set(["remove-item", "rm", "ri", "del", "erase", "rmdir"])
const CMD_DELETE = new Set(["rd", "rmdir", "del", "erase"])

function unquote(value: string) {
  let text = value.trim()
  while (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' || first === "'") && first === last) text = text.slice(1, -1).trim()
    else break
  }
  return text
}

function commandName(value: string) {
  const text = unquote(value).replaceAll("\\", "/")
  return (text.slice(text.lastIndexOf("/") + 1).replace(/\.exe$/i, "") || text).toLowerCase()
}

function unwrap(tokens: readonly string[]) {
  let index = 0
  while (index < tokens.length) {
    const name = commandName(tokens[index] ?? "")
    if (name === "sudo") {
      index++
      while (index < tokens.length && (tokens[index]?.startsWith("-") ?? false)) index++
      continue
    }
    if (name === "env") {
      index++
      while (index < tokens.length) {
        const value = tokens[index] ?? ""
        if (value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) index++
        else break
      }
      continue
    }
    if (POSIX_WRAPPERS.has(name)) {
      index++
      while (index < tokens.length && (tokens[index]?.startsWith("-") ?? false)) index++
      continue
    }
    break
  }
  return tokens.slice(index)
}

function hasBashRecursiveFlag(tokens: readonly string[]) {
  return tokens.some((raw) => {
    const value = unquote(raw)
    if (value === "--recursive") return true
    return /^-[^-]*[rR][^-]*$/.test(value)
  })
}

function hasPowerShellRecursiveFlag(tokens: readonly string[]) {
  return tokens.some((raw) => {
    const value = unquote(raw).toLowerCase()
    return value.length >= 2 && "-recurse".startsWith(value)
  })
}
function hasCmdRecursiveFlag(tokens: readonly string[]) {
  return tokens.some((raw) => /^\/s$/i.test(unquote(raw)))
}

function expandKnownHome(value: string, home: string) {
  const normalizedHome = home.replaceAll("\\", "/")
  const substitutions: Array<[RegExp, string]> = [
    [/^~(?=$|[\\/])/, normalizedHome],
    [/^\$\{HOME\}(?=$|[\\/])/i, normalizedHome],
    [/^\$HOME(?=$|[\\/])/i, normalizedHome],
    [/^\$\{env:USERPROFILE\}(?=$|[\\/])/i, normalizedHome],
    [/^\$env:USERPROFILE(?=$|[\\/])/i, normalizedHome],
    [/^%USERPROFILE%(?=$|[\\/])/i, normalizedHome],
  ]
  let out = value
  for (const [pattern, replacement] of substitutions) out = out.replace(pattern, replacement)
  return out
}

function pathFlavor(home: string, cwd: string) {
  return /^[A-Za-z]:[\\/]/.test(home) || /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix
}

function normalizeTarget(raw: string, options: ShellSafetyOptions) {
  let value = expandKnownHome(unquote(raw), options.home).replaceAll("\\", "/")
  if (!value || value === "--") return
  // Unknown interpolation is deliberately not guessed. Known home forms above
  // are expanded; dynamic expressions should be handled by the shell itself.
  if (value.includes("$") || value.includes("%") || value.includes("`")) return

  const flavor = pathFlavor(options.home, options.cwd)
  const wildcard = /([*?]+)$/.exec(value)?.[1] ?? ""
  if (wildcard) value = value.slice(0, -wildcard.length)
  const native = flavor === path.win32 ? value.replaceAll("/", "\\") : value
  const resolved = flavor.resolve(options.cwd, native).replaceAll("\\", "/")
  return { resolved: resolved.replace(/\/$/, "") || "/", wildcard }
}

function isDangerousTarget(raw: string, options: ShellSafetyOptions) {
  const target = normalizeTarget(raw, options)
  if (!target) return false

  const home = pathFlavor(options.home, options.cwd).resolve(options.home).replaceAll("\\", "/").replace(/\/$/, "")
  const value = target.resolved
  if (value === "/") return true
  if (/^[A-Za-z]:$/i.test(value)) return true
  if (value.toLowerCase() === home.toLowerCase()) return true

  // Git Bash exposes Windows drive roots as /c, /d, ... . Only recognize that
  // shape when the process home itself is a Windows path.
  if (/^[A-Za-z]:[\\/]/.test(options.home) && /^\/[A-Za-z]$/i.test(value)) return true
  return false
}

function targetTokens(tokens: readonly string[], kind: ShellSafetyKind) {
  const out: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const value = unquote(tokens[i] ?? "")
    if (!value || value === "--") continue
    if (kind === "cmd" && value.startsWith("/")) continue
    if (kind === "powershell" && value.startsWith("-")) continue
    if (kind === "bash" && value.startsWith("-")) continue
    out.push(value)
  }
  return out
}

/**
 * Returns a deterministic hard-block reason for only the narrowest class of
 * obviously catastrophic recursive deletes. This is intentionally not a
 * general command allow/deny policy: YOLO mode should keep normal development
 * operations frictionless.
 */
export function catastrophicDeleteReason(tokens: readonly string[], options: ShellSafetyOptions) {
  const command = unwrap(tokens)
  const name = commandName(command[0] ?? "")
  if (!name) return

  const recursive =
    options.kind === "bash"
      ? name === "rm" && hasBashRecursiveFlag(command.slice(1))
      : options.kind === "powershell"
        ? POWERSHELL_DELETE.has(name) && hasPowerShellRecursiveFlag(command.slice(1))
        : CMD_DELETE.has(name) && hasCmdRecursiveFlag(command.slice(1))
  if (!recursive) return

  return targetTokens(command, options.kind).some((target) => isDangerousTarget(target, options))
    ? BLOCK_MESSAGE
    : undefined
}

