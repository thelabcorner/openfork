export * as SwarmClaims from "./claims"

/**
 * Typed Swarm claim scopes.
 *
 * Claims were historically opaque free-text `scope` strings. That made them
 * purely advisory: two members could claim "the same thing" under different
 * spellings and nothing would ever notice. This module adds a *typed* scope
 * layer that is encoded back into the same durable `swarm_claim.scope` column,
 * so no storage migration is required and legacy rows stay readable.
 *
 * Encoding (canonical, round-trippable, and the only form that carries typed
 * semantics):
 *
 * ```text
 * path:<enc workspace>:<enc path>[/]   filesystem claim
 * lane:<enc lane>                      coordination lane
 * resource:<enc resource>              logical resource
 * <anything else>                      opaque / legacy
 * ```
 *
 * Each component is percent-encoded (`encodeURIComponent`) before joining on a
 * single `:` separator, so a `:` inside the workspace key, the path, the lane,
 * or the resource can never be confused with a component boundary. Percent
 * encoding also escapes `%`, spaces, and non-ASCII characters, which makes the
 * encoding injective and safely reversible for every string.
 *
 * ## Why `workspace` is part of a path scope
 *
 * Swarm members can be isolated by workspace policy (`shared-read`,
 * `shared-write`, `worktree`). Two members in different worktrees never write
 * the same bytes, so a path claim must never be compared across workspace
 * identities. Making the workspace an explicit, caller-supplied discriminator
 * keeps that a *caller* decision (the host resolves the member's workspace at
 * claim time) instead of a filesystem `stat` or a cwd guess.
 *
 * ## Case sensitivity is the host's decision, deliberately
 *
 * This evaluator compares normalized paths with **exact, case-sensitive string
 * equality**. It never lowercases. Core deliberately does not own filesystem
 * case-folding semantics: on Windows and macOS a host may map `A.ts` and `a.ts`
 * to one file, while on Linux it may not, and that fact is a property of the
 * real filesystem, not of a durable coordination row.
 *
 * Consequence: this module is **coordination-grade, not enforcement-grade on
 * its own**. Before typed path claims are used to hard-deny a mutation, the
 * host MUST canonicalize the candidate path and the claimed path through one
 * shared filesystem-canonicalization step (realpath plus the host's
 * case-folding rule) and only then compare them. `A.ts` vs `a.ts` are treated
 * as *different* paths here; see `CASE_SENSITIVITY` for the contract.
 *
 * ## Why directory coverage is explicit
 *
 * A bare path claim covers exactly that path. A trailing `/` marks the claim as
 * covering the directory subtree. The workspace root (`.` or `./`) is always
 * treated as a directory claim, since a single file *is* the root. This avoids
 * inventing "is it a directory?" filesystem probes on the coordination path and
 * keeps overlap deterministic and cheap.
 *
 * ## Opaque scopes
 *
 * Anything that does not parse is `{ kind: "opaque" }`. Opaque scopes are
 * preserved verbatim, never conflict, and never enforce. That is the explicit,
 * documented advisory escape hatch: opting into typed semantics is the only way
 * to opt into conflict detection.
 *
 * This module is deliberately pure. It holds no durable state, takes no locks,
 * and never blocks, so it cannot deadlock and can be reused from any mutation
 * boundary.
 */

/** A workspace discriminator for path claims. Callers pass the resolved member workspace identity. */
export type WorkspaceKey = string

export type ClaimScope =
  | { readonly kind: "path"; readonly workspace: WorkspaceKey; readonly path: string; readonly directory: boolean }
  | { readonly kind: "lane"; readonly lane: string }
  | { readonly kind: "resource"; readonly resource: string }
  | { readonly kind: "opaque"; readonly value: string }

/**
 * Case-handling contract for typed path claims, stated explicitly so no caller
 * can infer universal lowercasing from JS string comparison.
 */
export const CASE_SENSITIVITY = {
  /** The evaluator compares paths case-sensitively; it never lowercases. */
  coreComparison: "case-sensitive",
  /** Enforcement-grade use requires host filesystem canonicalization first. */
  requirement:
    "Mutation boundaries must canonicalize candidate and claimed paths with one shared host filesystem-canonicalization step (realpath + host case-folding rule) before comparing, because two paths differing only by case may be one file on Windows/macOS.",
} as const

export type ParseFailure =
  | { readonly reason: "empty" }
  | { readonly reason: "path_not_relative" }
  | { readonly reason: "path_escapes_root" }
  | { readonly reason: "malformed_encoding" }
  | { readonly reason: "missing_separator" }

const PATH_PREFIX = "path:"
const LANE_PREFIX = "lane:"
const RESOURCE_PREFIX = "resource:"

function encodeComponent(value: string): string {
  return encodeURIComponent(value)
}

function decodeComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Encode a normalized workspace-relative posix path.
 *
 * Each segment is percent-encoded independently and the `/` separators are kept
 * literal. That stays unambiguous (an encoded segment can never contain `/`,
 * `:`, or `%`) while keeping durable scopes human-readable, which matters
 * because claim scopes are surfaced to models through `claim.list`.
 */
function encodePathComponent(path: string): string {
  return path.split("/").map(encodeComponent).join("/")
}

/** Inverse of {@link encodePathComponent}; `undefined` means malformed encoding. */
function decodePathComponent(encoded: string): string | undefined {
  const segments: string[] = []
  for (const segment of encoded.split("/")) {
    const decoded = decodeComponent(segment)
    if (decoded === undefined) return undefined
    segments.push(decoded)
  }
  return segments.join("/")
}

/** Thrown-free parse result: callers decide between reject and degrade-to-opaque. */
export type ParseResult =
  | { readonly ok: true; readonly scope: ClaimScope }
  | { readonly ok: false; readonly failure: ParseFailure }

function normalizeSegments(input: string): readonly string[] | undefined {
  const out: string[] = []
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      // ".." is resolved against the accumulated segments; popping past the root
      // is an escape and is rejected.
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out
}

/**
 * Normalize a workspace-relative posix path. Returns `undefined` when the path
 * escapes the workspace root; absolute paths are rejected outright because a
 * path claim is only meaningful relative to its declared workspace.
 */
export function normalizeWorkspacePath(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return ""
  if (trimmed.includes("\\")) return undefined
  if (trimmed.startsWith("/")) return undefined
  const segments = normalizeSegments(trimmed)
  if (segments === undefined) return undefined
  return segments.join("/")
}

export function pathScope(workspace: WorkspaceKey, path: string, directory?: boolean): ParseResult {
  const ws = workspace.trim()
  if (!ws) return { ok: false, failure: { reason: "empty" } }
  const normalized = normalizeWorkspacePath(path)
  if (normalized === undefined)
    return { ok: false, failure: path.startsWith("/") ? { reason: "path_not_relative" } : { reason: "path_escapes_root" } }
  const explicitDirectory = path.trim().endsWith("/")
  // The workspace root is a single node, so a root claim is always subtree
  // coverage whether or not the caller wrote the trailing "/".
  const isDirectory = normalized === "" ? true : (directory ?? explicitDirectory)
  return {
    ok: true,
    scope: {
      kind: "path",
      workspace: ws,
      path: normalized,
      directory: isDirectory,
    },
  }
}

export function laneScope(lane: string): ParseResult {
  const value = lane.trim()
  if (!value) return { ok: false, failure: { reason: "empty" } }
  return { ok: true, scope: { kind: "lane", lane: value } }
}

export function resourceScope(resource: string): ParseResult {
  const value = resource.trim()
  if (!value) return { ok: false, failure: { reason: "empty" } }
  return { ok: true, scope: { kind: "resource", resource: value } }
}

/** True when the string claims to be in canonical typed encoding. */
export function isEncoded(scope: string): boolean {
  const trimmed = scope.trim()
  return trimmed.startsWith(PATH_PREFIX) || trimmed.startsWith(LANE_PREFIX) || trimmed.startsWith(RESOURCE_PREFIX)
}

function parseEncodedPath(rest: string): ParseResult {
  // Both components are percent-encoded, so the first *raw* ":" is the only
  // possible boundary: encodeURIComponent escapes ":" as "%3A", and "%" itself
  // as "%25", so neither component can contain an unescaped separator.
  const separator = rest.indexOf(":")
  if (separator < 0) return { ok: false, failure: { reason: "missing_separator" } }
  const workspace = decodeComponent(rest.slice(0, separator))
  const encodedPath = rest.slice(separator + 1)
  // The directory marker is a trailing "/" appended AFTER encoding. Encoded
  // segments can never contain a literal "/", so this marker is unambiguous.
  const directory = encodedPath.endsWith("/")
  // The path must be decoded BEFORE normalization: normalization and the
  // directory marker are defined on the semantic path, so "%2F" must be
  // resolved to "/" first rather than treated as a literal character.
  const rawPath = decodePathComponent(directory ? encodedPath.slice(0, -1) : encodedPath)
  if (workspace === undefined || rawPath === undefined)
    return { ok: false, failure: { reason: "malformed_encoding" } }
  if (!workspace.trim()) return { ok: false, failure: { reason: "empty" } }
  const normalized = normalizeWorkspacePath(rawPath)
  if (normalized === undefined)
    return { ok: false, failure: { reason: rawPath.startsWith("/") ? "path_not_relative" : "path_escapes_root" } }
  return {
    ok: true,
    scope: {
      kind: "path",
      workspace: workspace.trim(),
      path: normalized,
      // The workspace root is a single node, so it is always subtree coverage.
      directory: normalized === "" ? true : directory,
    },
  }
}

/**
 * Parse a durable scope string. Never throws: a malformed typed prefix is
 * reported as `ok: false` so the caller can decide between a validation error
 * and treating the value as opaque.
 */
export function parseScope(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, failure: { reason: "empty" } }
  if (trimmed.startsWith(LANE_PREFIX)) {
    const lane = decodeComponent(trimmed.slice(LANE_PREFIX.length))
    if (lane === undefined) return { ok: false, failure: { reason: "malformed_encoding" } }
    return laneScope(lane)
  }
  if (trimmed.startsWith(RESOURCE_PREFIX)) {
    const resource = decodeComponent(trimmed.slice(RESOURCE_PREFIX.length))
    if (resource === undefined) return { ok: false, failure: { reason: "malformed_encoding" } }
    return resourceScope(resource)
  }
  if (trimmed.startsWith(PATH_PREFIX)) return parseEncodedPath(trimmed.slice(PATH_PREFIX.length))
  return { ok: true, scope: { kind: "opaque", value: trimmed } }
}

/**
 * Canonical durable encoding for a typed scope. Opaque scopes round-trip
 * verbatim so legacy rows are byte-identical after hydration.
 */
export function encodeScope(scope: ClaimScope): string {
  switch (scope.kind) {
    case "path":
      return `${PATH_PREFIX}${encodeComponent(scope.workspace)}:${encodePathComponent(scope.path)}${scope.directory ? "/" : ""}`
    case "lane":
      return `${LANE_PREFIX}${encodeComponent(scope.lane)}`
    case "resource":
      return `${RESOURCE_PREFIX}${encodeComponent(scope.resource)}`
    case "opaque":
      return scope.value
  }
}

/**
 * Parse-then-reencode: the normalization the acquire path persists so that two
 * members spelling the same path differently converge on one durable row.
 * Returns the input unchanged when it is not a typed scope.
 */
export function canonicalizeScope(raw: string): string {
  const parsed = parseScope(raw)
  if (!parsed.ok) return raw.trim()
  return encodeScope(parsed.scope)
}

function pathCovers(claimPath: string, directory: boolean, target: string): boolean {
  if (claimPath === target) return true
  if (!directory) return false
  if (claimPath === "") return true // workspace-root directory claim
  return target.startsWith(`${claimPath}/`)
}

/**
 * Do two typed scopes overlap in a way that makes concurrent mutation unsafe?
 *
 * Rules:
 * - opaque never conflicts with anything (advisory escape hatch);
 * - different kinds never conflict;
 * - lane conflicts only with the same lane;
 * - resource conflicts only with the same resource;
 * - path conflicts only within the same workspace, and only when one covers
 *   the other (equal path, or a directory claim that prefixes the target).
 */
export function scopesOverlap(a: ClaimScope, b: ClaimScope): boolean {
  if (a.kind === "opaque" || b.kind === "opaque") return false
  if (a.kind !== b.kind) return false
  if (a.kind === "lane" && b.kind === "lane") return a.lane === b.lane
  if (a.kind === "resource" && b.kind === "resource") return a.resource === b.resource
  if (a.kind === "path" && b.kind === "path") {
    if (a.workspace !== b.workspace) return false
    return pathCovers(a.path, a.directory, b.path) || pathCovers(b.path, b.directory, a.path)
  }
  return false
}

/**
 * A claim row is *live* only while it is unreleased and unexpired. Expiry is a
 * first-class liveness fact: an expired claim must never block another member,
 * otherwise stale owners would deadlock the Swarm.
 */
export function isLiveClaim(
  row: { expiresAt?: number | null | undefined; releasedAt?: number | null | undefined },
  now: number,
): boolean {
  if (row.releasedAt !== undefined && row.releasedAt !== null) return false
  if (row.expiresAt === undefined || row.expiresAt === null) return true
  return row.expiresAt > now
}

export interface ConflictCandidate {
  readonly scope: string
  readonly memberID: string
  readonly lifecycle?: string | undefined
  /** SQL nullable columns arrive as `null`; both forms mean "not set". */
  readonly expiresAt?: number | null | undefined
  readonly releasedAt?: number | null | undefined
}

/**
 * Find live conflicting claims for a requested typed scope, excluding the
 * requesting member's own claims.
 *
 * `stopped` members are treated as non-owning: `acquireClaim` already refuses
 * to grant claims to `stopping`/`stopped` members, so a stopped member must not
 * be able to freeze a scope for the rest of the Swarm. `stopping` still owns
 * until it releases, because retirement is asynchronous.
 */
export function findConflicts(
  requested: ClaimScope,
  candidates: readonly ConflictCandidate[],
  options: { readonly now: number; readonly ownerMemberID?: string | undefined },
): readonly ConflictCandidate[] {
  if (requested.kind === "opaque") return []
  return candidates.filter((candidate) => {
    if (options.ownerMemberID !== undefined && candidate.memberID === options.ownerMemberID) return false
    if (candidate.lifecycle === "stopped") return false
    if (!isLiveClaim(candidate, options.now)) return false
    const parsed = parseScope(candidate.scope)
    if (!parsed.ok) return false
    return scopesOverlap(requested, parsed.scope)
  })
}