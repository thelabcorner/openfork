export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import type { Data, Definition, Payload } from "@opencode-ai/schema/event"
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm"
import { Database } from "./database/database"
import type { DatabaseShape } from "./database/database"
import {
  decodeValueBytesObject,
  isV4Frame,
  v4SegmentDecompressors,
  OCDBFrameError,
  isV5Frame,
  parseV5Header,
  decodeV5Correction,
  applyV5Correction,
  decodeValueBytesRaw,
  preencodeJson,
  preencodedJsonText,
} from "./database/json-codec"
import { decompressValueAsync } from "./database/decompress-pool"
import {
  EventPayloadChunkTable,
  EventPayloadMetaTable,
  EventSequenceTable,
  EventTable,
  EventValueTable,
} from "./event/sql"
import { Flag } from "./flag/flag"
import { EventTrace } from "./event-trace"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { estimateEventBytes } from "./event-replay"
import { indexSemanticEvent } from "./database/chunk-semantic"
import { isCompactedSequence, loadCompaction, recordCompactedSequences } from "./database/chunk-compaction"

const streamingDecoder = new TextDecoder()
type DatabaseReader = Pick<DatabaseShape, "select">

export const ID = Event.ID
export type ID = import("@opencode-ai/schema/event").ID
export type { Data, Definition, Payload } from "@opencode-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: DatabaseReader,
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Rehydration analog of json-codec's OCDBFrameError. Raised when a
 * `{"$cdbRef": "<id>"}` reference in `event.data` cannot be resolved to an
 * `event_value` row (dangling/corrupt). We FAIL CLOSED and never synthesize a
 * value — surfacing the break is safer than returning a plausible-but-wrong
 * payload.
 */
export class CdbRehydrateError extends Schema.TaggedErrorClass<CdbRehydrateError>()("EventV2.CdbRehydrateError", {
  aggregateID: Schema.String,
  valueID: Schema.String,
  reason: Schema.String,
}) {}

export class EventPayloadRehydrateError extends Schema.TaggedErrorClass<EventPayloadRehydrateError>()(
  "EventV2.EventPayloadRehydrateError",
  {
    payloadID: Schema.String,
    reason: Schema.String,
  },
) {}

const CDB_REF = "$cdbRef"
const EVENT_PAYLOAD_REF = "$eventPayload"
// Bound each implicit SQLite writer transaction to at most ~768 KiB even for
// three-byte UTF-8 BMP code points. ASCII/base64 payloads are exactly 256 KiB.
// A trailing high surrogate is carried into the next chunk so round-trip UTF-8
// encoding never substitutes U+FFFD at a chunk boundary.
const EVENT_PAYLOAD_CHUNK_CHARS = 256 * 1024
const EVENT_PAYLOAD_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
const EVENT_PAYLOAD_STARTUP_CLEANUP_LIMIT = 8

type EventPayloadRef = {
  readonly [EVENT_PAYLOAD_REF]: {
    readonly id: string
    readonly count: number
  }
}

/**
 * A promoted reference is EXACTLY `{"$cdbRef": "<value_id>"}` — a sole-key JSON
 * object. Requiring the sole key means a real payload that merely happens to
 * contain a `$cdbRef` field is never mistaken for a reference (it stays inline;
 * the hot path is unaffected).
 */
function isCdbRef(data: unknown): data is { readonly [CDB_REF]: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  if (Object.keys(record).length !== 1) return false
  return typeof record[CDB_REF] === "string"
}

function isEventPayloadRef(data: unknown): data is EventPayloadRef {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  if (Object.keys(record).length !== 1) return false
  const ref = record[EVENT_PAYLOAD_REF]
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return false
  const value = ref as Record<string, unknown>
  return typeof value.id === "string" && Number.isSafeInteger(value.count) && Number(value.count) > 0
}

function payloadChunkEnd(text: string, start: number) {
  let end = Math.min(text.length, start + EVENT_PAYLOAD_CHUNK_CHARS)
  if (end < text.length) {
    const tail = text.charCodeAt(end - 1)
    if (tail >= 0xd800 && tail <= 0xdbff) end -= 1
  }
  return end
}

/**
 * Stage an oversized canonical event body in short, independently committed
 * chunks. The semantic event is still committed atomically later; these rows
 * are unreachable until its tiny content-addressed reference is inserted.
 */
const stageEventPayload = Effect.fnUntraced(function* (db: DatabaseShape, text: string) {
  if (text.length <= EVENT_PAYLOAD_CHUNK_CHARS) return undefined

  const chunks: string[] = []
  const hash = createHash("sha256")
  for (let start = 0; start < text.length; ) {
    const end = payloadChunkEnd(text, start)
    const chunk = text.slice(start, end)
    chunks.push(chunk)
    hash.update(chunk, "utf8")
    start = end
    // Hashing/slicing a very large payload must not itself become one long JS
    // turn before the cooperative SQLite phase even starts.
    if (chunks.length % 8 === 0 && start < text.length) yield* Effect.yieldNow
  }
  const payloadID = hash.digest("hex")
  const touched = Date.now()

  // Publish-independent staging is intentionally allowed, so record a tiny
  // zero-ref lifecycle row first. If the process dies before the semantic
  // event commits, a later startup can distinguish this orphan from a payload
  // referenced by one or more durable events without scanning the event log.
  yield* db
    .insert(EventPayloadMetaTable)
    .values({ payload_id: payloadID, chunk_count: chunks.length, refs: 0, time_touched: touched })
    .onConflictDoUpdate({
      target: EventPayloadMetaTable.payload_id,
      set: { time_touched: touched },
    })
    .run()
    .pipe(Effect.orDie)

  // Identical jumbo payloads are naturally deduplicated. Count first so a
  // fully staged prior value avoids all writer work; a partial crash residue is
  // repaired by the idempotent inserts below.
  const existing = yield* db
    .select({ count: EventPayloadChunkTable.chunk_index })
    .from(EventPayloadChunkTable)
    .where(eq(EventPayloadChunkTable.payload_id, payloadID))
    .all()
    .pipe(Effect.orDie)
  if (existing.length !== chunks.length) {
    const created = Date.now()
    for (let index = 0; index < chunks.length; index++) {
      yield* db
        .insert(EventPayloadChunkTable)
        .values({ payload_id: payloadID, chunk_index: index, text: chunks[index]!, time_created: created })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // Release both the native connection permit and the Effect scheduler
      // between bounded writes so another Session's tiny durable commit can run.
      if (index + 1 < chunks.length) yield* Effect.yieldNow
    }
  }

  return { [EVENT_PAYLOAD_REF]: { id: payloadID, count: chunks.length } } satisfies EventPayloadRef
})

/**
 * Reclaim crash residue from prior processes. This runs while the EventV2
 * service is still constructing, before this process can publish anything.
 * A 24-hour grace window protects payloads another process may be staging; the
 * candidate is rechecked under IMMEDIATE writer ownership before deletion.
 */
const cleanupOrphanedEventPayloads = Effect.fnUntraced(function* (db: DatabaseShape) {
  const cutoff = Date.now() - EVENT_PAYLOAD_ORPHAN_GRACE_MS
  const candidates = yield* db
    .select({ payloadID: EventPayloadMetaTable.payload_id })
    .from(EventPayloadMetaTable)
    .where(and(eq(EventPayloadMetaTable.refs, 0), lt(EventPayloadMetaTable.time_touched, cutoff)))
    .limit(EVENT_PAYLOAD_STARTUP_CLEANUP_LIMIT)
    .all()
    .pipe(Effect.orDie)

  for (const candidate of candidates) {
    yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const meta = yield* db
              .select({ refs: EventPayloadMetaTable.refs, touched: EventPayloadMetaTable.time_touched })
              .from(EventPayloadMetaTable)
              .where(eq(EventPayloadMetaTable.payload_id, candidate.payloadID))
              .get()
              .pipe(Effect.orDie)
            if (!meta || meta.refs !== 0 || meta.touched >= cutoff) return
            yield* db
              .delete(EventPayloadChunkTable)
              .where(eq(EventPayloadChunkTable.payload_id, candidate.payloadID))
              .run()
              .pipe(Effect.orDie)
            yield* db
              .delete(EventPayloadMetaTable)
              .where(eq(EventPayloadMetaTable.payload_id, candidate.payloadID))
              .run()
              .pipe(Effect.orDie)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  }
})

/**
 * Epoch-3 HOT-VALUE rehydration cache: a per-database, size-bounded,
 * frequency-aware cache of `(aggregate_id, value_id)` -> decoded payload.
 *
 * - HOT-VALUE (ANVIL Experiment R): entries are weighted by `event_value.refs`
 *   (how many events share the payload). Eviction discards the LOWEST-refs
 *   entry first, so the most-referenced payloads — the "compiled hot set" —
 *   stay PRE-DECODED (parsed object) and replay at ZERO decompress + ZERO
 *   JSON.parse. A generic LRU would evict them under read churn; this does not.
 * - BOUNDED: capped at `REHYDRATE_CACHE_MAX_ENTRIES` entries and
 *   `REHYDRATE_CACHE_MAX_BYTES` of raw payload bytes, so a long-lived process
 *   can never grow the cache without bound.
 * - VALIDATED: a cached payload is byte-identical to the original. Frames are
 *   CRC-verified by `decodeValueBytesObject`; raw BLOBs are SHA-256 verified
 *   against `event_value.sha256` at decode time, so the memoized object is safe
 *   to reuse across reads.
 * - PER-DB: keyed by the live db instance via WeakMap, so distinct databases
 *   never share entries and the cache is GC'd with the connection.
 */
const REHYDRATE_CACHE_MAX_ENTRIES = 1024
const REHYDRATE_CACHE_MAX_BYTES = 64 * 1024 * 1024 // 64 MiB of raw payload bytes

interface RehydrateEntry {
  readonly value: unknown
  readonly bytes: number
  readonly refs: number
}

class RehydrateCache {
  private readonly map = new Map<string, RehydrateEntry>()
  private totalBytes = 0
  // Per-db observability. The cache is keyed by the live db via WeakMap, so
  // stats are scoped to one connection — never a process-wide sum that would
  // over-count when several db instances coexist (e.g. across test runs).
  hits = 0
  misses = 0
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): unknown | undefined {
    const entry = this.map.get(key)
    if (entry === undefined) return undefined
    // Recency touch (secondary signal); eviction is driven by refs, not order.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: unknown, bytes: number, refs: number): void {
    const existing = this.map.get(key)
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes
      this.map.delete(key)
    }
    this.map.set(key, { value, bytes, refs })
    this.totalBytes += bytes
    this.evict()
  }

  // Evict the lowest-refs entry first (LRU tiebreak among equal refs), so the
  // high-refs hot set survives read churn that would evict it from a plain LRU.
  // Strictly enforces `map.size <= maxEntries` after every write.
  private evict(): void {
    while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      let victim: string | undefined
      let victimRefs = Infinity
      for (const [k, e] of this.map) {
        if (e.refs < victimRefs) {
          victimRefs = e.refs
          victim = k
        }
      }
      if (victim === undefined) break
      const evicted = this.map.get(victim)
      if (evicted) this.totalBytes -= evicted.bytes
      this.map.delete(victim)
    }
  }

  get size(): number {
    return this.map.size
  }
}

const rehydrateCache = new WeakMap<object, RehydrateCache>()

const rehydrateCacheKey = (aggregateID: string, valueID: string) => `${aggregateID} ${valueID}`

/**
 * Epoch-3 rehydration cache stats for a SPECIFIC database connection. The cache
 * is per-db (keyed by the live db via WeakMap), so stats are scoped to `db` —
 * this is what callers/tests should assert against, not a process-wide sum.
 */
export const rehydrateCacheStats = (db: object) => {
  const cache = rehydrateCache.get(db)
  if (cache === undefined) return { hits: 0, misses: 0, entries: 0 }
  return { hits: cache.hits, misses: cache.misses, entries: cache.size }
}

/**
 * Resolve a single `$cdbRef` `value_id` against `event_value`: look up the row,
 * decode (frame or raw), SHA-256-validate against the stored hash, and return
 * the canonical payload. Shared by `rehydrateEvents` (event.data) and the #8
 * OPCL projection columns (session_message.data / message.data /
 * session.summary_diffs). Lookups use the table's real composite identity
 * `(aggregate_id, value_id)` instead of relying on a value-id naming convention.
 *
 * - FAIL-CLOSED by default: a dangling/corrupt ref throws `CdbRehydrateError`.
 * - `failSoft` (used for `session.summary_diffs`, Q4): returns `undefined`
 *   instead of throwing, so the caller can regenerate from event history.
 * - Cached per-db (refs-weighted) like the event.data path.
 */
export const resolveCdbRef = Effect.fn("EventV2.resolveCdbRef")(function* (
  db: DatabaseReader,
  aggregateID: string,
  valueID: string,
  opts?: { readonly failSoft?: boolean },
) {
  const failSoft = opts?.failSoft ?? false
  let cache = rehydrateCache.get(db)
  if (cache === undefined) {
    cache = new RehydrateCache(REHYDRATE_CACHE_MAX_ENTRIES, REHYDRATE_CACHE_MAX_BYTES)
    rehydrateCache.set(db, cache)
  }
  const cacheKey = rehydrateCacheKey(aggregateID, valueID)
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    cache.hits++
    return cached
  }
  cache.misses++
  const stored = yield* db
    .select({
      bytes: EventValueTable.bytes,
      sha256: EventValueTable.sha256,
      rawLen: EventValueTable.raw_len,
      refs: EventValueTable.refs,
    })
    .from(EventValueTable)
    .where(and(eq(EventValueTable.aggregate_id, aggregateID), eq(EventValueTable.value_id, valueID)))
    .all()
    .pipe(Effect.orDie)
  if (stored.length === 0) {
    if (failSoft) return undefined
    throw new CdbRehydrateError({ aggregateID, valueID, reason: "no event_value row for $cdbRef" })
  }
  const row = stored[0]
  const bytes = row.bytes as Uint8Array
  // v5 delta_ref frame (epoch-4 #10): the stored bytes are a sparse correction
  // against a base value in event_value. Load the base, apply the correction,
  // and SHA-validate the reconstructed payload. Fail-closed on a missing base
  // (quarantined by the ops-v2 repair path) — never silent degrade.
  if (isV5Frame(bytes)) {
    const header = parseV5Header(bytes)
    const baseRow = yield* db
      .select({ bytes: EventValueTable.bytes })
      .from(EventValueTable)
      .where(and(eq(EventValueTable.aggregate_id, aggregateID), eq(EventValueTable.value_id, header.baseValueId)))
      .all()
      .pipe(Effect.orDie)
    if (baseRow.length === 0) {
      if (failSoft) return undefined
      throw new CdbRehydrateError({ aggregateID, valueID, reason: "delta_ref base missing" })
    }
    const baseRaw = decodeValueBytesRaw(baseRow[0].bytes as Uint8Array)
    const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
    const raw = applyV5Correction(baseRaw, correction, header.totalRawLen)
    const actualSha = createHash("sha256").update(raw).digest("hex")
    if (actualSha !== row.sha256) {
      if (failSoft) return undefined
      throw new CdbRehydrateError({ aggregateID, valueID, reason: "sha256 mismatch for delta_ref payload" })
    }
    const value = JSON.parse(streamingDecoder.decode(raw))
    cache.set(cacheKey, value, header.totalRawLen, row.refs)
    return value
  }
  const useWorkers = Flag.OPENCODE_SEAL_WORKERS
  const decoded =
    useWorkers && bytes.length >= DECOMPRESS_POOL_THRESHOLD
      ? yield* Effect.promise(() => decompressValueAsync(bytes))
      : yield* decodeValueBytesObjectStreaming(bytes)
  const { value, raw } = decoded
  const actualSha = createHash("sha256").update(raw).digest("hex")
  if (actualSha !== row.sha256) {
    if (failSoft) return undefined
    throw new CdbRehydrateError({ aggregateID, valueID, reason: "sha256 mismatch for event_value payload" })
  }
  cache.set(cacheKey, value, row.rawLen, row.refs)
  return value
})

/**
 * #8 OPCL read path: resolve a `$cdbRef` in a collapsed projection column back
 * to its canonical payload. Gated on `Flag.OPENCODE_OPCL` (default OFF) — when
 * off, the value passes through untouched (no event_value lookup).
 *
 * - `session_message.data` / `message.data`: FAIL-CLOSED (a dangling ref throws
 *   `CdbRehydrateError`, consistent with event.data).
 * - `session.summary_diffs`: FAIL-SOFT (Q4) — a dangling ref returns `undefined`
 *   so the caller regenerates from event history instead of throwing.
 */
export const resolveProjectionRef = Effect.fn("EventV2.resolveProjectionRef")(function* (
  db: DatabaseReader,
  aggregateID: string,
  column: "session_message.data" | "message.data" | "session.summary_diffs" | "part.data",
  value: unknown,
) {
  if (!Flag.OPENCODE_OPCL) return value
  if (value === null || typeof value !== "object" || !isCdbRef(value)) return value
  const valueID = (value as Record<string, string>)[CDB_REF]
  if (column === "session.summary_diffs") {
    const resolved = yield* resolveCdbRef(db, aggregateID, valueID, { failSoft: true })
    if (resolved !== undefined) return resolved
    // Q4 fail-soft: regenerate from event history. A dangling/missing ref
    // returns `undefined` (caller sees no diffs) rather than throwing,
    // because summary_diffs are regenerable from git/snapshot. Log a
    // warning with the session id so the miss is observable.
    yield* Effect.logWarning(`session.summary_diffs ref unresolved for session ${aggregateID} (value_id=${valueID})`)
    return undefined
  }
  return yield* resolveCdbRef(db, aggregateID, valueID, { failSoft: false })
})

/** Test helper: reset the hit/miss counters for a specific db's cache. */
export const resetRehydrateCacheStats = (db: object) => {
  const cache = rehydrateCache.get(db)
  if (cache !== undefined) {
    cache.hits = 0
    cache.misses = 0
  }
}

/** Test helper: drop a specific db's rehydration cache entirely. */
export const resetRehydrateCache = (db: object) => {
  rehydrateCache.delete(db)
}

/**
 * Per-device cache tuning. Memory-constrained or hot-replay devices can shrink
 * the cache via env; large/replay-heavy servers can grow it. Read once at module
 * load (process-wide policy). Falls back to the defaults when unset/invalid.
 */
const REHYDRATE_CACHE_ENTRIES = Math.max(
  1,
  Number(process.env.OPENCODE_SEAL_CACHE_ENTRIES) || REHYDRATE_CACHE_MAX_ENTRIES,
)
const REHYDRATE_CACHE_BYTES = Math.max(
  1024 * 1024,
  (Number(process.env.OPENCODE_SEAL_CACHE_BYTES_MB) || REHYDRATE_CACHE_MAX_BYTES / (1024 * 1024)) * 1024 * 1024,
)

/**
 * Below this compressed size a reference decodes inline (sync) to avoid the
 * worker round-trip; at/above it the read path uses the decompress worker pool
 * so jumbo payloads and wide batches decompress in parallel off the main thread.
 */
const DECOMPRESS_POOL_THRESHOLD = 64 * 1024

/** Epoch-3 rehydration cache capacity (entries). Exposed for tests. */
export const REHYDRATE_CACHE_CAP_ENTRIES = REHYDRATE_CACHE_MAX_ENTRIES

/**
 * Incremental v4 decompression for the inline read path (ANVIL Experiment M2):
 * decompresses a v4 SEGMENTED frame one segment at a time, yielding between
 * segments via Effect.yieldNow so the event loop stays responsive during a
 * ~120ms jumbo decode (workers-off fallback; the worker-pool path is already
 * off-main-thread). Non-v4 frames and raw BLOBs decode in one sync pass via
 * decodeValueBytesObject.
 */
export const decodeValueBytesObjectStreaming = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    if (!isV4Frame(bytes)) return decodeValueBytesObject(bytes)
    const codec = bytes[5]
    const { totalRawLen, decompressors } = v4SegmentDecompressors(bytes, codec)
    const parts: Uint8Array[] = []
    let total = 0
    for (const decompress of decompressors) {
      const raw = decompress()
      parts.push(raw)
      total += raw.byteLength
      // Yield between segments so a 32MiB v4 frame doesn't block the read fiber
      // for ~120ms on the inline path.
      yield* Effect.yieldNow
    }
    if (total !== totalRawLen) throw new OCDBFrameError(`corrupt frame: expected ${totalRawLen}, got ${total}`)
    const out = new Uint8Array(total)
    let o = 0
    for (const part of parts) {
      out.set(part, o)
      o += part.byteLength
    }
    return { value: JSON.parse(streamingDecoder.decode(out)), raw: out }
  })

/**
 * Epoch-3 rehydration step for the event read path. Given rows materialized
 * from `event` (with `data` already parsed by the column's fromDriver), splice
 * any `{"$cdbRef": "<id>"}` references back to their full payloads, byte-exact.
 *
 * - HOT PATH: when `OPENCODE_SEAL_DEDUP` is off, or when no row in the batch is
 *   a reference, this returns the rows untouched with ZERO extra lookup.
 * - BATCHED LOOKUP: referenced value_ids are resolved in ONE `IN (...)` query
 *   against `event_value` for the aggregate — O(1) per read regardless of how
 *   many references share a payload.
 * - FUSED DECODE (ANVIL M): each referenced value is decompressed + JSON-parsed
 *   + sha256-validated in a single pass (`decodeValueBytesObject`), with no
 *   intermediate string kept alive and no re-encode for the integrity check.
 *   v4 SEGMENTED frames (>4MiB) decompress incrementally via
 *   `decodeValueBytesObjectStreaming` — one segment at a time with
 *   Effect.yieldNow between segments, so a ~120ms jumbo decode doesn't block
 *   the read fiber on the inline path (workers-off fallback; the worker-pool
 *   path is already off-main-thread).
 * - HOT-VALUE CACHE (ANVIL R): decoded payloads are memoized per
 *   (aggregate_id, value_id), weighted by `refs`, so the most-referenced
 *   payloads replay at ZERO decompress + ZERO JSON.parse.
 * - FAIL-CLOSED: a reference with no matching `event_value` row, or whose bytes
 *   fail sha256 validation, throws CdbRehydrateError rather than returning a
 *   fabricated value.
 */
const rehydrateStagedEventPayloads = Effect.fnUntraced(function* <
  R extends { readonly data: Record<string, unknown> },
>(db: DatabaseReader, rows: ReadonlyArray<R>) {
  const refs: Array<{ readonly row: R; readonly ref: EventPayloadRef[typeof EVENT_PAYLOAD_REF] }> = []
  for (const row of rows) {
    if (isEventPayloadRef(row.data)) refs.push({ row, ref: row.data[EVENT_PAYLOAD_REF] })
  }
  if (refs.length === 0) return rows

  const ids = Array.from(new Set(refs.map(({ ref }) => ref.id)))
  const stored = yield* db
    .select({
      payloadID: EventPayloadChunkTable.payload_id,
      index: EventPayloadChunkTable.chunk_index,
      text: EventPayloadChunkTable.text,
    })
    .from(EventPayloadChunkTable)
    .where(inArray(EventPayloadChunkTable.payload_id, ids))
    .orderBy(asc(EventPayloadChunkTable.payload_id), asc(EventPayloadChunkTable.chunk_index))
    .all()
    .pipe(Effect.orDie)

  const grouped = Map.groupBy(stored, (chunk) => chunk.payloadID)
  const resolved = new Map<string, Record<string, unknown>>()
  let resolvedCount = 0
  for (const { ref } of refs) {
    if (resolved.has(ref.id)) continue
    const chunks = grouped.get(ref.id) ?? []
    if (chunks.length !== ref.count) {
      throw new EventPayloadRehydrateError({
        payloadID: ref.id,
        reason: `expected ${ref.count} chunks, found ${chunks.length}`,
      })
    }
    const hash = createHash("sha256")
    const parts: string[] = []
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!
      if (chunk.index !== index) {
        throw new EventPayloadRehydrateError({
          payloadID: ref.id,
          reason: `expected chunk ${index}, found ${chunk.index}`,
        })
      }
      hash.update(chunk.text, "utf8")
      parts.push(chunk.text)
      if ((index + 1) % 8 === 0 && index + 1 < chunks.length) yield* Effect.yieldNow
    }
    if (hash.digest("hex") !== ref.id) {
      throw new EventPayloadRehydrateError({ payloadID: ref.id, reason: "sha256 mismatch" })
    }
    try {
      const value = JSON.parse(parts.join(""))
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("event payload is not an object")
      }
      resolved.set(ref.id, value as Record<string, unknown>)
      resolvedCount += 1
      // Parsing itself is intentionally fail-closed and synchronous, but never
      // parse several independent jumbo event bodies back-to-back in one
      // Effect turn. This bounds a cold multi-session replay burst to one JSON
      // construction before the scheduler can service other Sessions.
      if (resolvedCount < ids.length) yield* Effect.yieldNow
    } catch (cause) {
      if (cause instanceof EventPayloadRehydrateError) throw cause
      throw new EventPayloadRehydrateError({ payloadID: ref.id, reason: `invalid JSON: ${String(cause)}` })
    }
  }

  return rows.map((row) => {
    if (!isEventPayloadRef(row.data)) return row
    const value = resolved.get(row.data[EVENT_PAYLOAD_REF].id)
    if (!value) return row
    return { ...row, data: value }
  }) as R[]
})

export const rehydrateEvents = Effect.fn("EventV2.rehydrateEvents")(function* <
  R extends { readonly data: Record<string, unknown> },
>(db: DatabaseReader, aggregateID: string, rows: ReadonlyArray<R>) {
  const source = yield* rehydrateStagedEventPayloads(db, rows)
  if (!Flag.OPENCODE_SEAL_DEDUP) return source

  const refs: Array<{ row: R; valueID: string }> = []
  for (const row of source) {
    if (isCdbRef(row.data)) refs.push({ row, valueID: row.data[CDB_REF] })
  }
  if (refs.length === 0) return source

  const valueIDs = Array.from(new Set(refs.map((ref) => ref.valueID)))
  const stored = yield* db
    .select({
      valueID: EventValueTable.value_id,
      bytes: EventValueTable.bytes,
      sha256: EventValueTable.sha256,
      rawLen: EventValueTable.raw_len,
      refs: EventValueTable.refs,
    })
    .from(EventValueTable)
    .where(and(eq(EventValueTable.aggregate_id, aggregateID), inArray(EventValueTable.value_id, valueIDs)))
    .all()
    .pipe(Effect.orDie)

  const byID = new Map(stored.map((row) => [row.valueID, row] as const))

  let cache = rehydrateCache.get(db)
  if (cache === undefined) {
    cache = new RehydrateCache(REHYDRATE_CACHE_ENTRIES, REHYDRATE_CACHE_BYTES)
    rehydrateCache.set(db, cache)
  }

  // Split references into cache hits (served inline) and misses (need decode).
  // Misses are deduped by value_id: under dedup many events share one payload,
  // so we decode each unique payload ONCE (also avoids transferring the same
  // underlying buffer to the worker pool more than once, which would detach it).
  const missSet = new Set<string>()
  const resolved = new Map<string, unknown>()
  for (const row of source) {
    if (!isCdbRef(row.data)) continue
    const valueID = row.data[CDB_REF]
    const cached = cache.get(rehydrateCacheKey(aggregateID, valueID))
    if (cached !== undefined) {
      cache.hits++
      resolved.set(valueID, cached)
    } else {
      missSet.add(valueID)
    }
  }
  cache.misses += missSet.size
  const misses = Array.from(missSet, (valueID) => ({ valueID }))

  // Decompress misses. When `OPENCODE_SEAL_WORKERS` is on, payloads at/above
  // DECOMPRESS_POOL_THRESHOLD (and any batch of them) decompress IN PARALLEL
  // on the worker pool, so a jumbo row (~32MiB / ~120ms sync) or a wide batch
  // never blocks the read fiber on the main thread — the clog the sync path
  // would cause on cold replay. Small payloads decode inline to avoid the
  // worker round-trip overhead. sha256 is validated on the main thread over
  // the returned raw bytes (cheap, ~5–65us) before the value is trusted.
  const useWorkers = Flag.OPENCODE_SEAL_WORKERS
  const decodeOne = (valueID: string) =>
    Effect.gen(function* () {
      const storedRow = byID.get(valueID)
      // FAIL-CLOSED: a dangling/corrupt $cdbRef resolves to no event_value row.
      if (storedRow === undefined) {
        throw new CdbRehydrateError({ aggregateID, valueID, reason: "no event_value row for $cdbRef" })
      }
      const bytes = storedRow.bytes as Uint8Array
      if (isV5Frame(bytes)) {
        const header = parseV5Header(bytes)
        const baseRow = yield* db
          .select({ bytes: EventValueTable.bytes })
          .from(EventValueTable)
          .where(
            and(
              eq(EventValueTable.aggregate_id, aggregateID),
              eq(EventValueTable.value_id, header.baseValueId),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        if (baseRow.length === 0) {
          throw new CdbRehydrateError({ aggregateID, valueID, reason: "delta_ref base missing" })
        }
        const baseRaw = decodeValueBytesRaw(baseRow[0].bytes as Uint8Array)
        const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
        const raw = applyV5Correction(baseRaw, correction, header.totalRawLen)
        const actualSha = createHash("sha256").update(raw).digest("hex")
        if (actualSha !== storedRow.sha256) {
          throw new CdbRehydrateError({ aggregateID, valueID, reason: "sha256 mismatch for delta_ref payload" })
        }
        return {
          valueID,
          value: JSON.parse(streamingDecoder.decode(raw)),
          rawLen: storedRow.rawLen,
          refs: storedRow.refs,
        }
      }
      const decodedBytes =
        useWorkers && bytes.length >= DECOMPRESS_POOL_THRESHOLD
          ? yield* Effect.promise(() => decompressValueAsync(bytes))
          : yield* decodeValueBytesObjectStreaming(bytes)
      const { value, raw } = decodedBytes
      const actualSha = createHash("sha256").update(raw).digest("hex")
      if (actualSha !== storedRow.sha256) {
        throw new CdbRehydrateError({ aggregateID, valueID, reason: "sha256 mismatch for event_value payload" })
      }
      return { valueID, value, rawLen: storedRow.rawLen, refs: storedRow.refs }
    })
  const decoded = yield* Effect.all(
    misses.map((m) => decodeOne(m.valueID)),
    {
      concurrency: useWorkers ? 16 : 1,
    },
  )
  for (const d of decoded) {
    const key = rehydrateCacheKey(aggregateID, d.valueID)
    cache.set(key, d.value, d.rawLen, d.refs)
    resolved.set(d.valueID, d.value)
  }

  // Splice resolved payloads back into their rows, byte-exact.
  return source.map((row) => {
    if (!isCdbRef(row.data)) return row
    const value = resolved.get(row.data[CDB_REF])
    if (value === undefined) return row
    return { ...row, data: value as Record<string, unknown> }
  })
})

const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: { aggregateID: event.aggregateID, seq: event.seq, version: definition.durable.version },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}

export const readAggregate = Effect.fn("EventV2.readAggregate")(function* <A>(
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly after?: number
    readonly limit: number
    readonly manifest: {
      readonly definitions: ReadonlyMap<string, Definition>
      readonly schema: Schema.Decoder<A, never>
    }
  },
) {
  const after = input.after ?? -1
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.aggregateID),
        gt(EventTable.seq, after),
        inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const rehydrated = yield* rehydrateEvents(db, input.aggregateID, rows)
  const page = rehydrated.slice(0, input.limit)
  const decode = Schema.decodeUnknownSync(input.manifest.schema)
  const events = page.map((event) =>
    decode({
      id: event.id,
      type: input.manifest.definitions.get(event.type)?.type ?? event.type,
      durable: {
        aggregateID: event.aggregate_id,
        seq: event.seq,
        version: input.manifest.definitions.get(event.type)?.durable?.version,
      },
      data: event.data,
    }),
  )
  return {
    events,
    hasMore: rows.length > input.limit,
  }
})

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventV2.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  /**
   * Subscribe synchronously to one event type across all locations. Use this
   * instead of process-global `listen()` when a consumer only needs one type,
   * so high-rate unrelated events never invoke its callback.
   */
  readonly listenType: <D extends Definition>(definition: D, listener: Subscriber<D>) => Effect.Effect<Unsubscribe>
  /**
   * Subscribe synchronously to one event type at one exact Location. High-rate
   * location services should prefer this over `listen()` so events from another
   * project never invoke their callback just to be filtered out.
   */
  readonly listenLocation: <D extends Definition>(
    definition: D,
    location: Location.Ref,
    listener: Subscriber<D>,
  ) => Effect.Effect<Unsubscribe>
  /**
   * Subscribe to one event type for every workspace at a directory. This is
   * the preferred replacement for process-global `listen()` + a directory
   * check in per-project services.
   */
  readonly listenDirectory: <D extends Definition>(
    definition: D,
    directory: string,
    listener: Subscriber<D>,
  ) => Effect.Effect<Unsubscribe>
  /**
   * Subscribe to all event types at a directory. Intended for per-project
   * plugin/event bridges that genuinely need the complete local event stream
   * without paying process-global fanout for every other open project.
   */
  readonly listenDirectoryAll: (
    directory: string,
    listener: Subscriber,
  ) => Effect.Effect<Unsubscribe>
  /** Subscribe synchronously to one durable aggregate without process-global fanout. */
  readonly listenAggregate: (aggregateID: string, listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Event") {}

// For synchronous event emitters: never suspend a producer behind a slow
// subscriber, and never silently discard an append-only event on overflow.
export const makeSubscriberQueue = <A>(capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<A, SubscriberOverflowError>(capacity)
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid))
    let failed = false
    const offer = (event: A) => {
      if (failed) return false
      if (Queue.offerUnsafe(queue, event)) return true
      failed = true
      Queue.failCauseUnsafe(queue, Cause.fail(new SubscriberOverflowError({ capacity })))
      return false
    }
    return { queue, offer, stream: Stream.fromQueue(queue) }
  })

/**
 * A subscriber queue with both item and byte bounds.
 *
 * Item counts alone are insufficient for transports such as PTY sockets: one
 * read can be megabytes even when it is only one queued item. `take` is the
 * only supported drain operation so the retained-byte counter is released as
 * soon as a frame is handed to the writer.
 */
export const makeByteBoundedSubscriberQueue = <A>(options: {
  readonly capacity: number
  /**
   * Maximum ordinary backlog bytes, excluding the largest retained frame when
   * `maxSingleFrameBytes` is supplied. Without `maxSingleFrameBytes` this keeps
   * the historical total-retained-byte semantics.
   */
  readonly maxBytes: number
  /**
   * Optional independent per-frame ceiling. Transports use this when one
   * authoritative snapshot is legitimately close to the wire/ring limit: that
   * frame must not consume the entire ordinary backlog budget by itself.
   */
  readonly maxSingleFrameBytes?: number
  readonly sizeOf: (value: A) => number
  /** Metadata-only label for overflow traces; never return payload content. */
  readonly typeOf?: (value: A) => string | undefined
}) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Subscriber queue capacity must be positive")
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("Subscriber queue byte capacity must be positive")
    }
    if (
      options.maxSingleFrameBytes !== undefined &&
      (!Number.isFinite(options.maxSingleFrameBytes) || options.maxSingleFrameBytes <= 0)
    ) {
      throw new Error("Subscriber queue single-frame byte capacity must be positive")
    }
    const queue = yield* Queue.dropping<A, SubscriberOverflowError>(options.capacity)
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid))
    let failed = false
    let pendingBytes = 0
    let largestPendingBytes = 0
    const pendingSizes = new Map<number, number>()
    const singleFrameLimit = options.maxSingleFrameBytes ?? options.maxBytes
    const addPendingSize = (size: number) => {
      pendingSizes.set(size, (pendingSizes.get(size) ?? 0) + 1)
      if (size > largestPendingBytes) largestPendingBytes = size
    }
    const removePendingSize = (size: number) => {
      const count = pendingSizes.get(size)
      if (count === undefined) return
      if (count > 1) pendingSizes.set(size, count - 1)
      else pendingSizes.delete(size)
      if (size !== largestPendingBytes || count > 1) return
      largestPendingBytes = 0
      for (const retained of pendingSizes.keys()) {
        if (retained > largestPendingBytes) largestPendingBytes = retained
      }
    }
    const typeOf = (event: A) => {
      try {
        const value = options.typeOf?.(event)
        return value === undefined || value.length === 0 ? "unknown" : value
      } catch {
        return "unknown"
      }
    }
    const offer = (event: A) => {
      if (failed) return false
      const rawSize = options.sizeOf(event)
      const size = Number.isFinite(rawSize) ? Math.max(0, rawSize) : Number.POSITIVE_INFINITY
      const nextPendingBytes = pendingBytes + size
      const nextLargestBytes = Math.max(largestPendingBytes, size)
      const nextBacklogBytes =
        options.maxSingleFrameBytes === undefined ? nextPendingBytes : nextPendingBytes - nextLargestBytes
      if (size > singleFrameLimit || nextBacklogBytes > options.maxBytes) {
        failed = true
        EventTrace.count("queue.overflow")
        EventTrace.event({
          phase: "queue.overflow",
          capacity: options.capacity,
          size,
          type: typeOf(event),
          branch: size > singleFrameLimit ? "oversize" : "backpressure",
          pendingBytes,
          largestPendingBytes,
          backlogBytes: Math.max(0, pendingBytes - largestPendingBytes),
        })
        Queue.failCauseUnsafe(queue, Cause.fail(new SubscriberOverflowError({ capacity: options.capacity })))
        return false
      }
      if (Queue.offerUnsafe(queue, event)) {
        pendingBytes += size
        addPendingSize(size)
        EventTrace.count("queue.offered")
        EventTrace.sum("queue.offeredBytes", size)
        return true
      }
      failed = true
      EventTrace.count("queue.overflow")
      EventTrace.event({
        phase: "queue.overflow",
        capacity: options.capacity,
        size,
        type: typeOf(event),
        branch: "backpressure",
        pendingBytes,
        largestPendingBytes,
        backlogBytes: Math.max(0, pendingBytes - largestPendingBytes),
      })
      Queue.failCauseUnsafe(queue, Cause.fail(new SubscriberOverflowError({ capacity: options.capacity })))
      return false
    }
    const release = (event: A) =>
      Effect.sync(() => {
        const rawSize = options.sizeOf(event)
        const size = Number.isFinite(rawSize) ? Math.max(0, rawSize) : Number.POSITIVE_INFINITY
        pendingBytes = Math.max(0, pendingBytes - size)
        removePendingSize(size)
      })
    const take = Queue.take(queue).pipe(Effect.tap(release))
    // Do not expose the raw queue stream: consumers of `stream` do not call
    // the custom `take` effect, so using Stream.fromQueue directly would leak
    // retained-byte accounting after every successful read.
    const stream = Stream.fromQueue(queue).pipe(Stream.tap(release))
    return { queue, offer, take, stream, pendingBytes: () => pendingBytes }
  })

export const allBounded = (events: Interface, capacity: number, maxBytes = 8 * 1024 * 1024) =>
  Effect.gen(function* () {
    const subscriber = yield* makeByteBoundedSubscriberQueue<Payload>({
      capacity,
      maxBytes,
      sizeOf: estimateEventBytes,
      typeOf: (event) => event.type,
    })
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => subscriber.offer(event)))
    yield* Effect.addFinalizer(() => unsubscribe)
    return subscriber.stream
  })

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      // TODO: Bind durable projectors to exact type+version before supporting incompatible historical payloads.
      const listeners = new Array<Subscriber>()
      const typeListeners = new Map<string, Subscriber[]>()
      const locatedListeners = new Map<string, Subscriber[]>()
      const directoryListeners = new Map<string, Subscriber[]>()
      const directoryTypeListeners = new Map<string, Subscriber[]>()
      const aggregateListeners = new Map<string, Subscriber[]>()
      const { db, readDb } = yield* Database.Service
      yield* cleanupOrphanedEventPayloads(db)

      const locatedKey = (type: string, location: Location.Ref) =>
        `${type}\0${location.directory}\0${location.workspaceID ?? ""}`
      const directoryTypeKey = (type: string, directory: string) => `${type}\0${directory}`

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      function commitDurableEvent(
        definition: Definition,
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (durable) {
            const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${durable.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidDurableEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(event.type) ?? []
              // Schema encoding can walk/allocate multi-megabyte tool outputs.
              // It depends only on the immutable event payload, not transaction
              // state, so doing it after acquiring SQLite's single-connection
              // semaphore needlessly stalls every unrelated session. Prepare the
              // canonical row before entering the immediate transaction; keep
              // projectors + sequence advancement + inserts atomic below.
              const encoded = Schema.encodeUnknownSync(definition.data)(event.data) as Record<string, unknown>
              const encodedText = JSON.stringify(encoded)
              if (encodedText === undefined) return yield* Effect.die("Durable event data could not be JSON encoded")
              // Jumbo canonical bodies are staged as independently committed,
              // content-addressed chunks with scheduler yields between writes.
              // The semantic transaction below then inserts only a tiny ref.
              // Small events stay inline, but their JSON is still pre-encoded so
              // Drizzle does not stringify under the global writer permit.
              const staged = yield* stageEventPayload(db, encodedText)
              const storedData = staged ? preencodeJson(staged) : preencodedJsonText(encodedText)
              const sparseCheckpoint = definition.type === Event.Compacted.type
              const storedType = versionedType(definition.type, durable.version)
              let transactionStarted = 0
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          if (EventTrace.active()) transactionStarted = performance.now()
                          const row = yield* db
                            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && input.seq <= latest) {
                            if (sparseCheckpoint) {
                              const compaction = yield* loadCompaction(db, aggregateID)
                              if (isCompactedSequence(compaction?.bitmap, input.seq)) {
                                if (input.ownerID && row?.ownerID == null) {
                                  yield* db
                                    .update(EventSequenceTable)
                                    .set({ owner_id: input.ownerID })
                                    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                    .run()
                                    .pipe(Effect.orDie)
                                }
                                return
                              }
                            }
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            const canonicalStored = stored
                              ? (yield* rehydrateEvents(db, aggregateID, [stored]))[0]
                              : undefined
                            if (
                              canonicalStored?.id === event.id &&
                              canonicalStored.type === storedType &&
                              isDeepStrictEqual(canonicalStored.data, encoded)
                            ) {
                              if (input.ownerID && row?.ownerID == null) {
                                yield* db
                                  .update(EventSequenceTable)
                                  .set({ owner_id: input.ownerID })
                                  .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                  .run()
                                  .pipe(Effect.orDie)
                              }
                              return
                            }
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                              }),
                            )
                          }
                          if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                            return
                          }
                          const seq = input?.seq ?? latest + 1
                          if (input && seq !== latest + 1) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                              }),
                            )
                          }
                          const stored = yield* db
                            .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (stored)
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                          const committed = {
                            ...event,
                            durable: { aggregateID, seq, version: durable.version },
                          } as Payload
                          for (const projector of list) {
                            yield* projector(committed)
                          }
                          if (commit) yield* commit(seq)
                          yield* db
                            .insert(EventSequenceTable)
                            .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                            .onConflictDoUpdate({
                              target: EventSequenceTable.aggregate_id,
                              set: {
                                seq,
                                ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                              },
                            })
                            .run()
                            .pipe(Effect.orDie)
                          if (sparseCheckpoint) {
                            // `event.compacted.1` is a wire-level no-op in epoch
                            // 4. Advance the durable frontier, but persist only a
                            // single bit for this sequence instead of inserting a
                            // physical event row. Replays remain idempotent via
                            // the bitmap check above.
                            yield* recordCompactedSequences(db, aggregateID, [seq])
                            return { aggregateID, seq }
                          }
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                  seq,
                                  type: storedType,
                                  data: storedData as never,
                                },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          if (staged) {
                            const payloadID = staged[EVENT_PAYLOAD_REF].id
                            const meta = yield* db
                              .select({ refs: EventPayloadMetaTable.refs })
                              .from(EventPayloadMetaTable)
                              .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                              .get()
                              .pipe(Effect.orDie)
                            if (!meta) {
                              return yield* Effect.die(
                                new EventPayloadRehydrateError({
                                  payloadID,
                                  reason: "staged payload metadata disappeared before event commit",
                                }),
                              )
                            }
                            yield* db
                              .update(EventPayloadMetaTable)
                              .set({ refs: meta.refs + 1, time_touched: Date.now() })
                              .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                              .run()
                              .pipe(Effect.orDie)
                          }
                          if (Flag.OPENCODE_SEAL_PRUNE) {
                            yield* indexSemanticEvent(db, {
                              aggregateID,
                              seq,
                              type: definition.type,
                              data: encoded,
                            })
                          }
                          return { aggregateID, seq }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (transactionStarted > 0) {
                    const elapsed = performance.now() - transactionStarted
                    EventTrace.timing("durable.transaction", elapsed)
                    EventTrace.timing(`durable.transaction.${definition.type}`, elapsed)
                  }
                  if (committed) {
                    yield* Effect.forEach(
                      pubsub.durable.get(committed.aggregateID) ?? [],
                      (wake) => PubSub.publish(wake, undefined),
                      { discard: true },
                    )
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishEvent<D extends Definition>(definition: D, event: Payload<D>, commit?: PublishOptions["commit"]) {
        return Effect.gen(function* () {
          if (!definition?.durable && commit)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          if (definition?.durable) {
            const committed = yield* commitDurableEvent(definition, event as Payload, undefined, commit)
            if (committed) {
              event = {
                ...event,
                durable: {
                  aggregateID: committed.aggregateID,
                  seq: committed.seq,
                  version: definition.durable.version,
                },
              }
              yield* notify(event as Payload, true)
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const removeFrom = (registry: Map<string, Subscriber[]>, key: string, observer: Subscriber) => {
        const current = registry.get(key)
        if (!current) return
        const index = current.indexOf(observer)
        if (index >= 0) current.splice(index, 1)
        if (current.length === 0) registry.delete(key)
      }

      const observe = (
        event: Payload,
        observer: (event: Payload) => Effect.Effect<void>,
        detach: () => void,
      ) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.sync(() => {
                // A defective listener would otherwise be invoked and logged
                // for every subsequent token. Detach it after the first
                // failure; interruption remains observable and is not treated
                // as a subscriber defect.
                detach()
              }).pipe(
                Effect.andThen(
                  Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
                ),
              ),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          // The common streaming case has zero or one listener. Avoid a
          // per-event slice/allocation there while retaining a snapshot for
          // the multi-listener case, where a callback may unsubscribe itself.
          if (listeners.length === 1) {
            const listener = listeners[0]!
            // A live subscriber is outside the transaction boundary. Keep the
            // hot path inline, but still contain defects so a renderer/socket
            // listener can never make the producer's publish fail.
            yield* observe(event, listener, () => {
              const index = listeners.indexOf(listener)
              if (index >= 0) listeners.splice(index, 1)
            })
          } else if (listeners.length > 1) {
            const snapshot = listeners.slice()
            if (!isolateListeners) {
              // Hot path (streaming deltas): listeners are cheap synchronous
              // filter + Queue.offerUnsafe fan-out. Running them sequentially
              // preserves publish order and avoids spawning fibers per event;
              // `observe` contains a bad subscriber without forking a fiber.
              for (const listener of snapshot)
                yield* observe(event, listener, () => {
                  const index = listeners.indexOf(listener)
                  if (index >= 0) listeners.splice(index, 1)
                })
            } else {
              // Durable path: isolate listener failures so one bad subscriber
              // cannot fail the publish, with bounded parallelism.
              yield* Effect.forEach(
                snapshot,
                (listener) =>
                  observe(event, listener, () => {
                    const index = listeners.indexOf(listener)
                    if (index >= 0) listeners.splice(index, 1)
                  }),
                {
                  concurrency: 8,
                  discard: true,
                },
              )
            }
          }
          const typedListeners = typeListeners.get(event.type)
          if (typedListeners?.length === 1) {
            const listener = typedListeners[0]!
            yield* observe(event, listener, () => removeFrom(typeListeners, event.type, listener))
          } else if (typedListeners && typedListeners.length > 1) {
            const snapshot = typedListeners.slice()
            if (!isolateListeners) {
              for (const listener of snapshot)
                yield* observe(event, listener, () => removeFrom(typeListeners, event.type, listener))
            } else {
              yield* Effect.forEach(
                snapshot,
                (listener) => observe(event, listener, () => removeFrom(typeListeners, event.type, listener)),
                { concurrency: 8, discard: true },
              )
            }
          }
          if (event.location) {
            const key = locatedKey(event.type, event.location)
            const located = locatedListeners.get(key)
            if (located?.length === 1) {
              const listener = located[0]!
              yield* observe(event, listener, () => removeFrom(locatedListeners, key, listener))
            } else if (located && located.length > 1) {
              // Location-local callbacks are already a narrow set (normally
              // the filesystem index/search services for one project). Retain
              // ordering for live watcher traffic and isolate durable defects
              // consistently with process-global listeners.
              const snapshot = located.slice()
              if (!isolateListeners) {
                for (const listener of snapshot)
                  yield* observe(event, listener, () => removeFrom(locatedListeners, key, listener))
              } else {
                yield* Effect.forEach(
                  snapshot,
                  (listener) => observe(event, listener, () => removeFrom(locatedListeners, key, listener)),
                  { concurrency: 8, discard: true },
                )
              }
            }
            const directory = event.location.directory
            const typedDirectory = directoryTypeListeners.get(directoryTypeKey(event.type, directory))
            if (typedDirectory?.length === 1) {
              const listener = typedDirectory[0]!
              yield* observe(event, listener, () =>
                removeFrom(directoryTypeListeners, directoryTypeKey(event.type, directory), listener),
              )
            } else if (typedDirectory && typedDirectory.length > 1) {
              for (const listener of typedDirectory.slice())
                yield* observe(event, listener, () =>
                  removeFrom(directoryTypeListeners, directoryTypeKey(event.type, directory), listener),
                )
            }
            const directoryAll = directoryListeners.get(directory)
            if (directoryAll?.length === 1) {
              const listener = directoryAll[0]!
              yield* observe(event, listener, () => removeFrom(directoryListeners, directory, listener))
            } else if (directoryAll && directoryAll.length > 1) {
              for (const listener of directoryAll.slice())
                yield* observe(event, listener, () => removeFrom(directoryListeners, directory, listener))
            }
          }
          if (event.durable) {
            const key = event.durable.aggregateID
            const aggregate = aggregateListeners.get(key)
            if (aggregate?.length === 1) {
              const listener = aggregate[0]!
              yield* observe(event, listener, () => removeFrom(aggregateListeners, key, listener))
            } else if (aggregate && aggregate.length > 1) {
              const snapshot = aggregate.slice()
              yield* Effect.forEach(
                snapshot,
                (listener) => observe(event, listener, () => removeFrom(aggregateListeners, key, listener)),
                { concurrency: 8, discard: true },
              )
            }
          }
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            definition,
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options?.commit,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(definition, payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* notify(
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                  },
                },
                true,
              )
            }
          }
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(
            () =>
            Effect.gen(function* () {
              const payloadRows = yield* db
                .select({ data: EventTable.data })
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, aggregateID))
                .all()
                .pipe(Effect.orDie)
              const payloadRefs = new Map<string, number>()
              for (const row of payloadRows) {
                if (!isEventPayloadRef(row.data)) continue
                const payloadID = row.data[EVENT_PAYLOAD_REF].id
                payloadRefs.set(payloadID, (payloadRefs.get(payloadID) ?? 0) + 1)
              }
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
              for (const [payloadID, count] of payloadRefs) {
                const meta = yield* db
                  .select({ refs: EventPayloadMetaTable.refs })
                  .from(EventPayloadMetaTable)
                  .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                  .get()
                  .pipe(Effect.orDie)
                if (!meta) continue
                yield* db
                  .update(EventPayloadMetaTable)
                  .set({ refs: Math.max(0, meta.refs - count), time_touched: Date.now() })
                  .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                  .run()
                  .pipe(Effect.orDie)
              }
            }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const replayPageSize = 256
      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            readDb
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .limit(replayPageSize)
              .all(),
          ),
          Effect.orDie,
          Effect.flatMap((rows) => rehydrateEvents(readDb, aggregateID, rows)),
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              }),
            ),
          ),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, sequence)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  sequence = events.at(-1)?.durable?.seq ?? sequence
                }),
              ),
            )
            // A wake represents "there is work", not one page. Drain until a
            // short page so coalesced wakes cannot strand historical events.
            // Subscription precedes every read, preserving the replay/live handoff.
            const drain = Stream.fromEffectRepeat(read).pipe(
              Stream.takeUntil((events) => events.length < replayPageSize),
              Stream.flattenIterable,
            )
            const live = Stream.fromSubscription(wakes).pipe(Stream.flatMap(() => drain))
            return Stream.concat(drain, live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          if (listeners.length > 0 && listeners.length % 50 === 0) {
            void Effect.runFork(
              Effect.logWarning("Event listener count is unusually high", { count: listeners.length }),
            )
          }
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const listenType = <D extends Definition>(
        definition: D,
        listener: Subscriber<D>,
      ): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          const key = definition.type
          const list = typeListeners.get(key) ?? []
          const subscriber = listener as Subscriber
          list.push(subscriber)
          typeListeners.set(key, list)
          return Effect.sync(() => removeFrom(typeListeners, key, subscriber))
        })

      const listenLocation = <D extends Definition>(
        definition: D,
        location: Location.Ref,
        listener: Subscriber<D>,
      ): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          const key = locatedKey(definition.type, location)
          const list = locatedListeners.get(key) ?? []
          const subscriber = listener as Subscriber
          list.push(subscriber)
          locatedListeners.set(key, list)
          return Effect.sync(() => {
            const current = locatedListeners.get(key)
            if (!current) return
            const index = current.indexOf(subscriber)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) locatedListeners.delete(key)
          })
        })

      const listenDirectory = <D extends Definition>(
        definition: D,
        directory: string,
        listener: Subscriber<D>,
      ): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          const key = directoryTypeKey(definition.type, directory)
          const list = directoryTypeListeners.get(key) ?? []
          const subscriber = listener as Subscriber
          list.push(subscriber)
          directoryTypeListeners.set(key, list)
          return Effect.sync(() => removeFrom(directoryTypeListeners, key, subscriber))
        })

      const listenDirectoryAll = (
        directory: string,
        listener: Subscriber,
      ): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          const list = directoryListeners.get(directory) ?? []
          list.push(listener)
          directoryListeners.set(directory, list)
          return Effect.sync(() => removeFrom(directoryListeners, directory, listener))
        })

      const listenAggregate = (aggregateID: string, listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          const list = aggregateListeners.get(aggregateID) ?? []
          list.push(listener)
          aggregateListeners.set(aggregateID, list)
          return Effect.sync(() => removeFrom(aggregateListeners, aggregateID, listener))
        })

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        durable,
        listen,
        listenType,
        listenLocation,
        listenDirectory,
        listenDirectoryAll,
        listenAggregate,
        project,
        replay,
        replayAll,
        remove,
        claim,
      })
    }),
  )

const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
