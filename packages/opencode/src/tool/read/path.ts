import * as path from "path"
import { Effect } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"

const DOT_USER_PATH = /^([A-Za-z]:\\Users\\)([^\\]+)\.([^\\]+)(\\.*)$/i
const USERS_USERS = /^([A-Za-z]:\\Users)\\Users\\/i

export type GlobSearch = (input: {
  cwd: string
  pattern: string
  limit: number
}) => Effect.Effect<readonly { path: string }[]>

type Stat = ReturnType<typeof statPath> extends Effect.Effect<infer S, any, any> ? S : never
type StatInfo = Stat

export function fixDotUserPath(filepath: string): string | undefined {
  const match = filepath.match(DOT_USER_PATH)
  if (!match) return
  return `${match[1]}${match[2]}\\${match[3]}${match[4]}`
}

export function fixUsersUsers(filepath: string): string | undefined {
  const next = filepath.replace(USERS_USERS, "$1\\")
  return next !== filepath ? next : undefined
}

export function isPosixAbsoluteOnWindows(filepath: string): boolean {
  return process.platform === "win32" && filepath.startsWith("/") && !filepath.startsWith("//")
}

export function posixSuffixes(directory: string, posix: string): string[] {
  const parts = posix.split("/").filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push(path.join(directory, ...parts.slice(i)))
  }
  return out
}

export function escapeGlob(value: string): string {
  return value.replace(/[*?[\]{}]/g, "\\$&")
}

export function extensionFlips(filepath: string): string[] {
  const ext = path.extname(filepath)
  const stem = filepath.slice(0, filepath.length - ext.length)
  const map: Record<string, string[]> = {
    ".ts": [".tsx", ".js", ".mts", ".cts"],
    ".tsx": [".ts", ".jsx"],
    ".js": [".ts", ".jsx", ".mjs"],
    ".jsx": [".tsx", ".js"],
    ".mjs": [".js", ".mts"],
    ".mts": [".ts", ".mjs"],
    ".cts": [".ts", ".cjs"],
    ".md": [".mdx"],
    ".mdx": [".md"],
  }
  return (map[ext.toLowerCase()] ?? []).map((next) => stem + next)
}

export function stemOf(filepath: string): string {
  return path.basename(filepath, path.extname(filepath)).toLowerCase()
}

export function sameStem(left: string, right: string): boolean {
  return stemOf(left) === stemOf(right)
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function coerceFilePaths(value: ReadonlyArray<string> | string): string[] {
  if (typeof value !== "string") return [...value]
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(
        `filePaths must be a JSON array of strings. Example: {"filePaths":["C:\\\\proj\\\\a.ts","C:\\\\proj\\\\b.ts"]}`,
      )
    }
    return parsed as string[]
  }
  return [trimmed]
}

export const statPath = (fs: FSUtil.Interface, filepath: string) =>
  fs.stat(filepath).pipe(
    Effect.catchIf(
      (err) => "reason" in err && err.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  )

const toPosix = (value: string) => value.replaceAll("\\", "/")

const inNodeModules = (value: string) => toPosix(value).includes("/node_modules/")

const unique = <T>(items: readonly T[]): T | undefined => (items.length === 1 ? items[0] : undefined)

export const resolveReadPath = Effect.fn("ReadTool.resolveReadPath")(function* (
  fs: FSUtil.Interface,
  input: { filepath: string; directory: string; glob?: GlobSearch },
) {
  const original = input.filepath
  let filepath = original
  let info = yield* statPath(fs, filepath)
  let repaired: string | undefined
  let candidates: string[] = []

  const accept = (next: string, note: string, stat: NonNullable<typeof info>) => {
    filepath = next
    info = stat
    repaired = note
  }

  if (!info) {
    const dotted = fixDotUserPath(filepath)
    if (dotted) {
      const next = yield* statPath(fs, dotted)
      if (next) accept(dotted, `rewrote ${original} → ${dotted} (dot instead of path separator)`, next)
    }
  }

  if (!info) {
    const users = fixUsersUsers(original)
    if (users) {
      const next = yield* statPath(fs, users)
      if (next) accept(users, `rewrote ${original} → ${users} (Users\\\\Users collapse)`, next)
    }
  }

  if (!info && isPosixAbsoluteOnWindows(original)) {
    for (const candidate of posixSuffixes(input.directory, original)) {
      const next = yield* statPath(fs, candidate)
      if (next) {
        accept(candidate, `POSIX path on Windows; mapped ${original} → ${candidate}`, next)
        break
      }
    }
  }

  if (!info) {
    const healed = yield* healMissing(fs, {
      filepath: original,
      directory: input.directory,
      glob: input.glob,
    })
    candidates = healed.candidates
    if (healed.hit) accept(healed.hit.path, healed.hit.note, healed.hit.stat)
  }

  return { filepath, stat: info, repaired, candidates, requested: original }
})

const healMissing = Effect.fn("ReadTool.healMissing")(function* (
  fs: FSUtil.Interface,
  input: { filepath: string; directory: string; glob?: GlobSearch },
) {
  const candidates: string[] = []
  const files: Array<{ path: string; note: string; stat: Exclude<StatInfo, undefined> }> = []

  const consider = Effect.fnUntraced(function* (abs: string, note: string) {
    if (!sameStem(input.filepath, abs)) return
    if (inNodeModules(abs) && !inNodeModules(input.filepath)) return
    const stat = yield* statPath(fs, abs)
    if (!stat) return
    if (stat.type === "Directory") {
      candidates.push(`${abs}/`)
      return
    }
    if (stat.type !== "File") return
    if (files.some((item) => path.resolve(item.path) === path.resolve(abs))) return
    files.push({ path: abs, note, stat })
  })

  const dir = path.dirname(input.filepath)
  const dirStat = yield* statPath(fs, dir)
  if (dirStat?.type === "Directory") {
    for (const flip of extensionFlips(input.filepath)) {
      yield* consider(flip, `same stem, ${path.extname(flip)} not ${path.extname(input.filepath)}`)
    }
    const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const base = path.basename(input.filepath)
    const want = stemOf(input.filepath)
    for (const name of names) {
      if (name === base) continue
      if (stemOf(name) !== want && name.toLowerCase() !== base.toLowerCase()) continue
      yield* consider(
        path.join(dir, name),
        name.toLowerCase() === base.toLowerCase() ? "case-insensitive match" : `same stem in ${dir}`,
      )
    }
    const local = unique(files)
    if (local) return { hit: local, candidates: [] }
    if (files.length > 1) return { hit: undefined, candidates: files.map((item) => item.path) }
  }

  const listed = () => [...candidates, ...files.map((item) => item.path)]

  if (!input.glob || !isInside(input.directory, input.filepath)) {
    return { hit: undefined, candidates: listed() }
  }

  const rel = isInside(input.directory, input.filepath)
    ? path.relative(input.directory, input.filepath)
    : path.basename(input.filepath)
  const parts = toPosix(rel).split("/").filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join("/")
    const pattern = `**/${escapeGlob(tail)}`
    const found = yield* input.glob({ cwd: input.directory, pattern, limit: 8 }).pipe(
      Effect.catch(() => Effect.succeed([] as Array<{ path: string }>)),
    )
    files.length = 0
    for (const item of found) {
      const abs = path.resolve(input.directory, item.path)
      if (!isInside(input.directory, abs)) continue
      yield* consider(abs, `unique match for ${tail}`)
    }
    const hit = unique(files)
    if (hit) return { hit: { ...hit, note: `healed ${input.filepath} → ${hit.path} (${hit.note})` }, candidates: [] }
    if (files.length > 1) return { hit: undefined, candidates: files.map((item) => item.path) }
  }

  return { hit: undefined, candidates: listed() }
})
