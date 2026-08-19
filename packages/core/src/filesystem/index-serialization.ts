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

export * as IndexSerialization from "./index-serialization"
