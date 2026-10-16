export * as SkillPathSafety from "./path-safety"

import { createHash } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"

/**
 * Single owner for turning remote-controlled skill catalog data into filesystem
 * targets and URLs.
 *
 * A skill index is untrusted input fetched over the network. Every value in it —
 * the skill name, each package-relative file, the resolved resource URL — is
 * attacker-controlled and must be validated *before* it becomes a path that
 * gets written to. Both the current/Core (`skill/discovery.ts`) and V1
 * (`packages/opencode/src/skill/discovery.ts`) discovery paths route through
 * these helpers so containment semantics cannot drift between generations, and
 * so neither path grows a private weaker copy.
 *
 * The rules split into two layers on purpose:
 *
 *  - `isSafeSegment` / `isSafeRelativePath` are platform-independent string
 *    predicates. They reject separators in BOTH posix and windows form, so a
 *    catalog authored on one platform cannot smuggle a separator past the other.
 *  - `resolveContained` and friends are platform-aware. They resolve and then
 *    prove containment through `FSUtil.contains`, which is the existing native
 *    Core containment owner and already handles cross-volume escapes.
 *
 * Validation alone is not sufficient: a value can pass every predicate and
 * still escape once resolved. Every helper that returns a filesystem target
 * therefore returns `undefined` instead of a path when the containment proof
 * fails, so a caller cannot accidentally use an unproven value.
 */

/**
 * Canonicalize a configured skill source URL into a directory-style base.
 *
 * Returns `undefined` for anything that is not a usable http(s) origin. Callers
 * must treat that as "no skills from this source" rather than passing the raw
 * string to `new URL(...)`, which would throw and turn a bad config value into
 * a defect instead of a rejected source.
 */
export function canonicalSourceUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  // Append the trailing slash to the PATHNAME, never to the href string. For a
  // configured URL that carries a query or fragment, appending to href would
  // place the slash inside the query/fragment (".../skills?token=x/"), which
  // changes the meaning of the source instead of making it a directory.
  // Assigning pathname makes the URL re-serialize with query/fragment trailing.
  // A query-free source canonicalizes exactly as before.
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`
  return parsed.href
}

/**
 * Cache namespace for a canonical source base URL.
 *
 * Namespaces per source so two different catalogs can never share a directory
 * and overwrite each other's staged swaps, and so one catalog cannot enumerate
 * or poison another's cached skills.
 *
 * The namespace is a truncated SHA-256 digest of the canonical base, not a
 * runtime hash. A non-cryptographic runtime hash makes this value depend on the
 * Bun version and the hash algorithm's stability guarantees: an upgrade could
 * silently place the same source under a different directory, and a chosen
 * collision would let one catalog land on another's namespace. SHA-256 is
 * fixed, so the mapping is stable across runtimes and upgrades.
 *
 * This intentionally changes the on-disk cache layout relative to earlier
 * releases, which costs one re-download of already-cached remote skills.
 */
export function sourceNamespace(base: string): string {
  return createHash("sha256").update(base).digest("hex").slice(0, 32)
}

/**
 * A remote-controlled value usable as exactly one path segment.
 *
 * Rejects empty, `.`, `..`, and anything containing a posix separator, a
 * windows separator, or a NUL byte.
 *
 * A colon is rejected as defense in depth. `C:..` contains no separator and is
 * not literally `..`, but `path.win32.resolve(root, "C:..")` resolves to a drive
 * root and escapes. `resolveContained` is the real proof that such a value can
 * never become a target; this keeps it from reaching the resolver at all, and
 * a colon cannot appear in a legitimate skill directory name on any platform we
 * ship.
 */
export function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes(":")
  )
}

/**
 * A remote-controlled value usable as a package-relative path beneath a skill
 * root.
 *
 * Beyond rejecting traversal and separators, this rejects values that are
 * themselves URLs (`//evil.example/x` is protocol-relative and would otherwise
 * silently retarget the fetch to another origin) and values carrying `?`/`#`,
 * which would be truncated into a different filename on disk than the one
 * fetched. Each segment is checked after percent-decoding, so `%2e%2e%2f`
 * cannot decode into a traversal that the raw check missed.
 */
export function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          decoded.length > 0 &&
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("\0")
        )
      } catch {
        return false
      }
    })
  )
}

/**
 * Resolve `child` beneath `parent` and prove it did not escape.
 *
 * Returns `undefined` when the resolved target equals `parent` or falls outside
 * it. The containment proof is delegated to `FSUtil.contains` so this module
 * adds no second, weaker notion of containment.
 */
export function resolveContained(parent: string, child: string): string | undefined {
  const resolved = path.resolve(parent, child)
  if (resolved === parent) return undefined
  if (!FSUtil.contains(parent, resolved)) return undefined
  return resolved
}

/**
 * Resolve a remote-controlled skill name to its directory under the per-source
 * cache root, proving containment.
 */
export function resolveSkillRoot(sourceRoot: string, name: string): string | undefined {
  if (!isSafeSegment(name)) return undefined
  return resolveContained(sourceRoot, name)
}

/**
 * Resolve a remote-controlled package-relative file to its download target
 * beneath a skill root, proving containment.
 */
export function resolveSkillFile(root: string, file: string): string | undefined {
  if (!isSafeRelativePath(file)) return undefined
  return resolveContained(root, file)
}

/**
 * Resolve a remote-controlled file entry to the URL it should be fetched from,
 * refusing any value that leaves the source origin.
 *
 * `skillBase` is the already-canonical URL of the skill directory within the
 * source (for example `.../deploy/`), and `file` is the untrusted catalog entry
 * resolved against it. Origin comparison — not prefix comparison — is the check
 * that matters: `https://host/a/` and `https://host.evil/a/` share a string
 * prefix but not an origin.
 */
export function resolveResourceUrl(source: URL, skillBase: string, file: string): URL | undefined {
  if (!isSafeRelativePath(file)) return undefined
  let resource: URL
  try {
    resource = new URL(file, skillBase)
  } catch {
    return undefined
  }
  if (resource.origin !== source.origin) return undefined
  return resource
}
