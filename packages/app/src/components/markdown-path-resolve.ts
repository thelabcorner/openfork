/**
 * Resolving the paths that appear in assistant prose.
 *
 * Messages name files the way a person would — `patch_dist.mjs`, `diff.mjs`,
 * `candidate/snapdom-candidate.mjs` — not as absolute paths. Handing those
 * straight to the OS resolves them against the desktop process's working
 * directory, which is why they came back "not found". The project's file index
 * (the same one behind the `@` mention popover) knows where they actually live.
 *
 * Index paths and project directories do not agree on a separator, and a single
 * best guess is often wrong, so resolution produces an ordered list of
 * candidates in one normalized form and the caller probes until a real file
 * answers.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC = /^(?:\\\\|\/\/)/

export function isAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith("/")) return true
  // UNC shares (`\\server\share`) and Windows drives.
  if (WINDOWS_UNC.test(value)) return true
  return WINDOWS_DRIVE.test(value)
}

/** Whichever separator the directory already speaks. */
function preferredSeparator(directory: string) {
  return directory.includes("\\") ? "\\" : "/"
}

/**
 * Rewrites every separator to one convention.
 *
 * The file index answers with `/` while a Windows project directory uses `\`,
 * so a naive join yields `C:\repo\lane4-scratch/v3prod/sink_ab.mjs` — a path
 * that reads as broken and travels badly.
 */
export function normalizeSeparators(value: string, separator: string): string {
  if (!value) return value
  const unc = WINDOWS_UNC.test(value)
  const body = value.replace(/[\\/]+/g, separator)
  return unc ? separator + body : body
}

export function joinPath(directory: string, relative: string): string {
  if (!directory) return relative
  if (isAbsolutePath(relative)) return normalizeSeparators(relative, preferredSeparator(relative))
  const separator = preferredSeparator(directory)
  const base = directory.replace(/[\\/]+$/, "")
  const tail = relative.replace(/^[\\/]+/, "")
  if (!tail) return normalizeSeparators(base, separator)
  return normalizeSeparators(`${base}${separator}${tail}`, separator)
}

export function basename(value: string): string {
  const end = value.replace(/[\\/]+$/, "")
  if (!end) return value
  const slash = Math.max(end.lastIndexOf("/"), end.lastIndexOf("\\"))
  return slash === -1 ? end : end.slice(slash + 1)
}

const normalize = (value: string) =>
  value
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()

const depth = (value: string) => {
  if (!value) return 0
  let out = 1
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 47) out++
  return out
}

function rankEntries<T>(written: string, candidates: readonly T[], pathOf: (candidate: T) => string): T[] {
  if (!written || candidates.length === 0) return []
  const target = normalize(written)
  if (!target) return []
  const targetName = basename(target)
  const exact: Array<{ candidate: T; depth: number; index: number }> = []
  const suffixed: Array<{ candidate: T; depth: number; index: number }> = []
  const named: Array<{ candidate: T; depth: number; index: number }> = []

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!
    const value = normalize(pathOf(candidate))
    if (!value) continue
    const ranked = { candidate, depth: depth(value), index }
    if (value === target) exact.push(ranked)
    else if (value.endsWith(`/${target}`)) suffixed.push(ranked)
    else if (basename(value) === targetName) named.push(ranked)
  }

  const byDepth = (a: { depth: number; index: number }, b: { depth: number; index: number }) =>
    a.depth - b.depth || a.index - b.index
  exact.sort(byDepth)
  suffixed.sort(byDepth)
  named.sort(byDepth)
  return [...exact, ...suffixed, ...named].map((entry) => entry.candidate)
}

/**
 * Orders index entries by how much of the written path they corroborate:
 * an exact match, then a full trailing-segment match (`candidate/x.mjs` inside
 * `a/candidate/x.mjs`), then a bare filename match. Within a tier the
 * shallowest path wins, since prose saying `diff.mjs` usually means the
 * top-level one rather than a copy buried in fixtures.
 */
export function rankPathMatches(written: string, candidates: readonly string[]): string[] {
  return rankEntries(written, candidates, (candidate) => candidate)
}

export function pickPathMatch(written: string, candidates: readonly string[]): string | undefined {
  return rankPathMatches(written, candidates)[0]
}

/**
 * Every absolute path worth trying for a written mention, best first.
 *
 * Index entries are normally project-relative, but nothing guarantees it, and
 * the written text may already be usable on its own — so each possibility is
 * offered rather than betting on one.
 */
export function pathCandidates(input: {
  written: string
  directory: string
  canonicalDirectory?: string
  matches: readonly string[]
}): string[] {
  const { written, directory, canonicalDirectory, matches } = input
  const out: string[] = []
  const seen = new Set<string>()
  const candidateKey = (value: string) =>
    WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value)
      ? value.replace(/[\\/]+/g, "/").toLowerCase()
      : value
  const push = (value: string | undefined) => {
    if (!value) return
    const key = candidateKey(value)
    if (seen.has(key)) return
    seen.add(key)
    out.push(value)
  }

  if (isAbsolutePath(written)) {
    push(normalizeSeparators(written, preferredSeparator(written)))
    return out
  }

  // When prose includes a relative subpath, it is more specific than fuzzy
  // basename hits. Newer servers expose their canonical workspace root once
  // per page, so try that exact relative path first even if duplicate filenames
  // pushed the intended entry beyond the search page.
  const canonicalLiteral = canonicalDirectory ? joinPath(canonicalDirectory, written) : undefined
  const hasSubpath = /[\\/]/.test(written)
  if (canonicalLiteral && hasSubpath) push(canonicalLiteral)

  for (const match of rankPathMatches(written, matches)) {
    if (isAbsolutePath(match)) {
      push(normalizeSeparators(match, preferredSeparator(match)))
      continue
    }
    // A new server's base is authoritative. Duplicating every fuzzy hit under
    // the renderer's directory can double IPC/stat work without adding a new
    // server-backed location. Older servers still use the client directory.
    push(joinPath(canonicalDirectory ?? directory, match))
  }
  // The mention may already be project-relative and simply absent from the index.
  // For bare filenames, a ranked index hit is more informative than an extra
  // root-level stat. Keep the canonical literal only when it adds information.
  if (hasSubpath || matches.length === 0) push(canonicalLiteral)
  push(joinPath(directory, written))
  return out
}

/** Selects the first candidate that exists. Older desktop builds can omit the probe. */
export async function firstExistingPath(
  candidates: readonly string[],
  exists?: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined
  if (!exists) return candidates[0]
  let successfulProbe = false
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const found = await exists(candidate)
      successfulProbe = true
      if (found) return candidate
    } catch (error) {
      lastError = error
      // A single failed probe must not let a stale row block a later valid
      // candidate. If every probe fails, surface the bridge error below instead
      // of misreporting it as "file not found".
    }
  }
  if (!successfulProbe && lastError !== undefined) throw lastError
  return undefined
}

/** Produces the ordered candidates for a written path. */
export type MarkdownPathResolver = (written: string) => Promise<string[]>

let current: MarkdownPathResolver | undefined

/**
 * The toolbar is mounted app-wide but the file index is session-scoped, so the
 * session subtree publishes its resolver here rather than the toolbar reaching
 * across scopes for a context it cannot see.
 */
export function setMarkdownPathResolver(resolver: MarkdownPathResolver | undefined): () => void {
  current = resolver
  return () => {
    if (current === resolver) current = undefined
  }
}

export function resolveMarkdownCandidates(written: string): Promise<string[]> {
  if (!written) return Promise.resolve([])
  if (isAbsolutePath(written)) {
    return Promise.resolve([normalizeSeparators(written, preferredSeparator(written))])
  }
  if (!current) return Promise.resolve([])
  return current(written).catch(() => [])
}
