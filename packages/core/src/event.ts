export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import type { Data, Definition, Payload } from "@opencode-ai/schema/event"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
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
} from "./database/json-codec"
import { decompressValueAsync } from "./database/decompress-pool"
import { EventSequenceTable, EventTable } from "./event/sql"
import { EventValueTable } from "./event/sql"
import { Flag } from "./flag/flag"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"

const streamingDecoder = new TextDecoder()

export const ID = Event.ID
export type ID = import("@opencode-ai/schema/event").ID
export type { Data, Definition, Payload } from "@opencode-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
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
export class CdbRehydrateError extends Schema.TaggedErrorClass<CdbRehydrateError>()(
  "EventV2.CdbRehydrateError",
  {
    aggregateID: Schema.String,
    valueID: Schema.String,
    reason: Schema.String,
  },
) {}

const CDB_REF = "$cdbRef"

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
const REHYDRATE_CACHE_MAX_BYTES = 32 * 1024 * 1024 // 32 MiB of raw payload bytes

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
 * session.summary_diffs). The write side stores `value_id` as globally unique
 * (`aggregate_id:seq:sha8`), so the lookup keys on `value_id` alone — matching
 * chunk-rebuild.ts's verification.
 *
 * - FAIL-CLOSED by default: a dangling/corrupt ref throws `CdbRehydrateError`.
 * - `failSoft` (used for `session.summary_diffs`, Q4): returns `undefined`
 *   instead of throwing, so the caller can regenerate from event history.
 * - Cached per-db (refs-weighted) like the event.data path.
 */
export const resolveCdbRef = Effect.fn("EventV2.resolveCdbRef")(
  function* (db: DatabaseShape, aggregateID: string, valueID: string, opts?: { readonly failSoft?: boolean }) {
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
      .where(eq(EventValueTable.value_id, valueID))
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
    const decoded = useWorkers && bytes.length >= DECOMPRESS_POOL_THRESHOLD
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
  },
)

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
export const resolveProjectionRef = Effect.fn("EventV2.resolveProjectionRef")(
  function* (
    db: DatabaseShape,
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
  },
)

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
  (Number(process.env.OPENCODE_SEAL_CACHE_BYTES_MB) || 32) * 1024 * 1024,
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
export const rehydrateEvents = Effect.fn("EventV2.rehydrateEvents")(
  function* <R extends { readonly data: Record<string, unknown> }>(
    db: DatabaseShape,
    aggregateID: string,
    rows: ReadonlyArray<R>,
  ) {
    if (!Flag.OPENCODE_SEAL_DEDUP) return rows

    const refs: Array<{ row: R; valueID: string }> = []
    for (const row of rows) {
      if (isCdbRef(row.data)) refs.push({ row, valueID: row.data[CDB_REF] })
    }
    if (refs.length === 0) return rows

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
    for (const row of rows) {
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
        const decodedBytes = useWorkers && bytes.length >= DECOMPRESS_POOL_THRESHOLD
          ? yield* Effect.promise(() => decompressValueAsync(bytes))
          : yield* decodeValueBytesObjectStreaming(bytes)
        const { value, raw } = decodedBytes
        const actualSha = createHash("sha256").update(raw).digest("hex")
        if (actualSha !== storedRow.sha256) {
          throw new CdbRehydrateError({ aggregateID, valueID, reason: "sha256 mismatch for event_value payload" })
        }
        return { valueID, value, rawLen: storedRow.rawLen, refs: storedRow.refs }
      })
    const decoded = yield* Effect.all(misses.map((m) => decodeOne(m.valueID)), {
      concurrency: useWorkers ? 16 : 1,
    })
    for (const d of decoded) {
      const key = rehydrateCacheKey(aggregateID, d.valueID)
      cache.set(key, d.value, d.rawLen, d.refs)
      resolved.set(d.valueID, d.value)
    }

    // Splice resolved payloads back into their rows, byte-exact.
    return rows.map((row) => {
      if (!isCdbRef(row.data)) return row
      const value = resolved.get(row.data[CDB_REF])
      if (value === undefined) return row
      return { ...row, data: value as Record<string, unknown> }
    })
  },
)

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

export const allBounded = (events: Interface, capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
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
      const { db } = yield* Database.Service

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
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          const encoded = Schema.encodeUnknownSync(definition.data)(event.data) as Record<
                            string,
                            unknown
                          >
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && input.seq <= latest) {
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            if (
                              stored?.id === event.id &&
                              stored.type === versionedType(definition.type, durable.version) &&
                              isDeepStrictEqual(stored.data, encoded)
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
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(definition.type, durable.version),
                                data: encoded,
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          return { aggregateID, seq }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
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

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
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
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
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

      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .all(),
          ),
          Effect.orDie,
          Effect.flatMap((rows) => rehydrateEvents(db, aggregateID, rows)),
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
            const historical = yield* read
            const live = Stream.fromSubscription(wakes).pipe(
              Stream.mapEffect(() => read),
              Stream.flattenIterable,
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          // notify() runs this array on every published event (including the SSE
          // heartbeat every 10s), so an accumulation of listeners whose owning
          // connection died without a clean close (no FIN/RST -- laptop sleep,
          // wifi drop, VPN blip) silently makes every future publish slower. TCP
          // keepalive is meant to reap those, but its timing depends on OS
          // defaults we don't fully control; log loudly if the count climbs well
          // past what a normal session should ever have open, so a stuck growth
          // is visible in logs instead of only showing up as an unexplained
          // global slowdown.
          if (listeners.length > 0 && listeners.length % 50 === 0) {
            void Effect.runFork(Effect.logWarning("Event listener count is unusually high", { count: listeners.length }))
          }
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
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
