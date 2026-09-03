import { Effect, Schema } from "effect"
import { RelativePath } from "../schema"
import { Hash } from "../util/hash"

/**
 * Serialization codec for the persisted per-project file index.
 *
 * Implements `contract/index-format` (v1) + `spec/serialization/canonical-json`:
 * a JSON blob whose top-level `digest` is the sha256 of the canonical JSON of
 * every OTHER top-level field. Canonical JSON is byte-reproducible (sorted
 * keys, no whitespace, UTF-8/LF, no trailing newline) so the digest survives
 * round-trips across writers and platforms.
 *
 * `encode` produces the exact bytes to persist (temp+rename is the caller's
 * concern). `decode` parses, validates the schema, and verifies the digest;
 * any failure is a `DecodeError` the caller should treat as a cache miss.
 */

export interface IndexEntry extends Schema.Schema.Type<typeof IndexEntry> {}
export const IndexEntry = Schema.Struct({
  path: RelativePath,
  type: Schema.Literals(["file", "directory"]),
  size: Schema.optional(Schema.Number),
  mtime: Schema.optional(Schema.Number),
  lineCount: Schema.optional(Schema.Number),
}).annotate({ identifier: "FileIndex.Entry" })

export interface IndexSubtree extends Schema.Schema.Type<typeof IndexSubtree> {}
export const IndexSubtree = Schema.Struct({
  at: Schema.Number,
  entries: Schema.Array(IndexEntry),
}).annotate({ identifier: "FileIndex.Subtree" })

export interface IndexRootStat extends Schema.Schema.Type<typeof IndexRootStat> {}
export const IndexRootStat = Schema.Struct({
  mtimeMs: Schema.Number,
  size: Schema.Number,
  ino: Schema.Number,
}).annotate({ identifier: "FileIndex.RootStat" })

export interface IndexBlob extends Schema.Schema.Type<typeof IndexBlob> {}
export const IndexBlob = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  builtAt: Schema.Number,
  root: Schema.String,
  rootStat: IndexRootStat,
  digest: Schema.String,
  subtrees: Schema.Record(Schema.String, IndexSubtree),
}).annotate({ identifier: "FileIndex.Blob" })

/** The blob shape as produced by a builder, before the digest is computed. */
export type IndexBlobInput = Omit<IndexBlob, "digest">

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("FileIndex.DecodeError", {
  reason: Schema.Literals(["invalid", "checksum", "version"]),
}) {}

/** Canonical JSON string: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** Canonical JSON as UTF-8 bytes (LF, no trailing newline). */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

/** sha256 hex of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return Hash.sha256(Buffer.from(bytes))
}

/** Encode an index (without digest) into the exact bytes to persist. */
export function encode(input: IndexBlobInput): Uint8Array {
  const digest = sha256Hex(canonicalBytes(input))
  return canonicalBytes({ ...input, digest })
}

/** Parse + validate + verify the digest of a persisted blob. */
export const decode = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8").decode(bytes)),
      catch: () => new DecodeError({ reason: "invalid" }),
    })
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      return yield* new DecodeError({ reason: "version" })
    }
    const blob = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(IndexBlob)(parsed),
      catch: () => new DecodeError({ reason: "invalid" }),
    })
    const { digest, ...rest } = blob
    if (sha256Hex(canonicalBytes(rest)) !== digest) {
      return yield* new DecodeError({ reason: "checksum" })
    }
    return blob
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Compact local Brotli manifest (v2) — optimized for `.opencode/file-index.json.br`.
 *
 * Goals vs the canonical `FileIndex.Blob` (which is kept for the global
 * `file-index/*.json` cache):
 * - No redundant keys: subtrees are an array of `[dir, at, entries]` tuples
 *   instead of `Record<dir, {at,entries}>` with repeated `"path"/"type"/"at"/"entries"` keys.
 * - No redundant path prefixes: each entry stores only its basename
 *   (`[0|1, "Button.tsx"]`) instead of the full `src/components/Button.tsx`
 *   — the dir prefix is implied, saving ~30-40% JSON bytes before Brotli and
 *   halving string allocations on parse.
 * - Numeric type (0=file,1=directory) instead of string.
 * - Short top-level keys (`v,b,r,s,d`) and tuple rootStat `[mtime,size,ino]`.
 * - No canonicalization or digest — the local file is content-addressed by
 *   atomic rename and `root` check on load; skipping the sha256 + sort saves
 *   50-150 ms on 50k-entry encodes.
 * - Plain `JSON.parse` + manual reconstruction instead of `Schema.decode` —
 *   3-5× faster decode and far less GC pressure.
 */
/** `[kind, name]` or `[0, name, size, mtime]` for files with captured meta. */
export type CompactEntry = [0 | 1, string] | [0, string, number, number]
export type CompactDir = [string, number, CompactEntry[]]
export interface CompactBlob {
  v: 2
  b: number // builtAt
  r: string // root
  s: [number, number, number] // [mtimeMs,size,ino]
  d: CompactDir[]
}

export function encodeCompact(input: {
  builtAt: number
  root: string
  rootStat: { mtimeMs: number; size: number; ino: number }
  subtrees: Map<string, { at: number; entries: readonly { path: string; type: string; size?: number; mtime?: number }[] }>
}): Uint8Array {
  const dirs: CompactDir[] = []
  // Pre-allocate and avoid per-entry sort: entries are already stored
  // sorted (dirs-first, alphabetical) via `compareEntries`. Files with
  // captured size/mtime use a 4-tuple; dirs and unstated files stay 2-tuple
  // so old decoders (length===2) still work and we don't write zeros.
  for (const [dir, sub] of input.subtrees) {
    const entries: CompactEntry[] = new Array(sub.entries.length)
    const prefixLen = dir ? dir.length + 1 : 0
    let j = 0
    for (let i = 0; i < sub.entries.length; i++) {
      const e = sub.entries[i]!
      const full = e.path as string
      const name = prefixLen ? full.slice(prefixLen) : full
      if (name.includes("/")) continue
      if (e.type === "directory") {
        entries[j++] = [1, name]
        continue
      }
      const size = e.size
      const mtime = e.mtime
      entries[j++] =
        typeof size === "number" && Number.isFinite(size) && typeof mtime === "number" && mtime > 0
          ? [0, name, size, mtime]
          : [0, name]
    }
    if (j !== entries.length) entries.length = j
    dirs.push([dir, sub.at, entries])
  }
  dirs.sort((a, b) => a[0].localeCompare(b[0]))
  const blob: CompactBlob = { v: 2, b: input.builtAt, r: input.root, s: [input.rootStat.mtimeMs, input.rootStat.size, input.rootStat.ino], d: dirs }
  return new TextEncoder().encode(JSON.stringify(blob))
}

export function decodeCompact(bytes: Uint8Array): {
  builtAt: number
  root: string
  rootStat: { mtimeMs: number; size: number; ino: number }
  subtrees: Map<string, { at: number; entries: { path: string; type: string; size?: number; mtime?: number }[] }>
} | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CompactBlob
    if (parsed?.v !== 2 || typeof parsed.b !== "number" || typeof parsed.r !== "string" || !Array.isArray(parsed.s) || !Array.isArray(parsed.d)) return undefined
    const [mtimeMs, size, ino] = parsed.s
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(size) || !Number.isFinite(ino)) return undefined
    const subtrees = new Map<string, { at: number; entries: { path: string; type: string; size?: number; mtime?: number }[] }>()
    for (const entry of parsed.d) {
      if (!Array.isArray(entry) || entry.length !== 3) return undefined
      const [dir, at, ents] = entry as CompactDir
      if (typeof dir !== "string" || typeof at !== "number" || !Array.isArray(ents)) return undefined
      const list: { path: string; type: string; size?: number; mtime?: number }[] = []
      for (const ce of ents) {
        if (!Array.isArray(ce) || ce.length < 2 || ce.length > 4) return undefined
        const t = ce[0]
        const name = ce[1]
        if ((t !== 0 && t !== 1) || typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined
        const full = dir ? `${dir}/${name}` : name
        if (t === 1) {
          list.push({ path: full, type: "directory" })
          continue
        }
        const fileSize = typeof ce[2] === "number" && Number.isFinite(ce[2]) ? ce[2] : undefined
        const fileMtime = typeof ce[3] === "number" && ce[3] > 0 ? ce[3] : undefined
        list.push({ path: full, type: "file", size: fileSize, mtime: fileMtime })
      }
      subtrees.set(dir, { at, entries: list })
    }
    return { builtAt: parsed.b, root: parsed.r, rootStat: { mtimeMs, size, ino }, subtrees }
  } catch {
    return undefined
  }
}

export * as IndexSerialization from "./index-serialization"
