import { Glob } from "../util/glob"

const FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
  ".opencode",
])

const FILES = [
  "**/*.swp",
  "**/*.swo",
  "**/*.pyc",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
]

export const PATTERNS = [...FILES, ...FOLDERS]

const normalize = (file: string) => file.replaceAll("\\", "/")

/**
 * Watcher coverage for the current tracked set.
 *
 * The default ignore rules are folder/glob based and bound event volume, but
 * some of them match directories and files that a project genuinely tracks
 * (`.opencode/`, `packages/desktop/`, a root `bin/`, a tracked `*.log`). A
 * watcher that hides tracked files is a freshness bug, not an optimization.
 *
 * `coverage` separates the two:
 * - `native` is the safe subset of `PATTERNS` to hand to the native backend;
 *   a pattern that would hide a tracked file is dropped so those paths are
 *   delivered.
 * - `whitelist` are the path globs the callback guard must not drop, one per
 *   directory (or exact file) that provably contains tracked files.
 *
 * Volume stays bounded: a generated `node_modules`/`dist` that tracks nothing
 * is neither whitelisted nor removed from the native list.
 */
export interface Coverage {
  readonly native: readonly string[]
  readonly whitelist: readonly string[]
  readonly overridden: readonly string[]
}

export function coverage(files: Iterable<string>): Coverage {
  const list = [...files].map(normalize)
  const overridden = new Set<string>()
  const whitelist = new Set<string>()

  for (const pattern of PATTERNS) {
    if (pattern.includes("*")) {
      for (const file of list) {
        if (!Glob.match(pattern, file)) continue
        overridden.add(pattern)
        whitelist.add(file)
        break
      }
      continue
    }

    // A pattern that matches a tracked entry at the watched root must leave the
    // native ignore list, otherwise the backend never delivers those events.
    for (const file of list) {
      if (file === pattern) {
        overridden.add(pattern)
        whitelist.add(file)
        break
      }
      if (file.startsWith(`${pattern}/`)) {
        overridden.add(pattern)
        break
      }
    }

    // Every directory below a tracked file that carries this segment must be
    // whitelisted for the callback guard, at any depth.
    for (const file of list) {
      const parts = file.split("/")
      for (let index = 0; index < parts.length - 1; index++) {
        if (parts[index] === pattern) whitelist.add(`${parts.slice(0, index + 1).join("/")}/**`)
      }
    }
  }

  return {
    native: PATTERNS.filter((pattern) => !overridden.has(pattern)),
    whitelist: [...whitelist],
    overridden: [...overridden],
  }
}

/**
 * Whether the native subscription's rules ignore this path. Bare folder names
 * are root-relative there (a nested folder is only bound by the callback guard);
 * glob rules apply at any depth.
 */
export function nativeIgnored(filepath: string, native: readonly string[] = PATTERNS): boolean {
  const normalized = normalize(filepath)
  const parts = normalized.split("/")
  for (const pattern of native) {
    if (pattern.includes("*")) {
      if (Glob.match(pattern, normalized)) return true
      continue
    }
    if (parts[0] === pattern) return true
  }
  return false
}

export function match(filepath: string, opts?: { extra?: string[]; whitelist?: readonly string[] }) {
  const normalized = normalize(filepath)

  for (const pattern of opts?.whitelist || []) {
    if (Glob.match(pattern, normalized)) return false
  }

  const parts = normalized.split("/")
  for (const part of parts) {
    if (FOLDERS.has(part)) return true
  }

  for (const pattern of [...FILES, ...(opts?.extra || [])]) {
    if (Glob.match(pattern, normalized)) return true
  }

  return false
}

export * as Ignore from "./ignore"
