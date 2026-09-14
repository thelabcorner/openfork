import { createHash } from "node:crypto"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Event } from "@opencode-ai/schema/event"
import type { DatabaseShape } from "./database"

type SqlExecutor = Pick<DatabaseShape, "get" | "run">

/**
 * Sparse semantic-compaction storage.
 *
 * A dense bitset is intentionally used instead of ranges/roaring metadata. The
 * bit domain is the aggregate's durable sequence, so total bitmap capacity is
 * bounded by total event count (one bit per historical sequence). On the real
 * ~685k-event corpus that is only ~84 KiB before SQLite row overhead, while a
 * range table required >200k rows because compacted snapshots are heavily
 * interleaved with other durable event classes.
 */
export const CHECKPOINT_TYPE = `${Event.Compacted.type}.${Event.Compacted.durable!.version}`

export type CompactionRow = {
  readonly aggregateID: string
  readonly bitmap: Uint8Array
  readonly count: number
}

// 16 MiB represents 134,217,728 durable positions in a single aggregate. This
// is far beyond realistic session history while preventing a corrupt sequence
// value from turning bitmap growth into an unbounded allocation.
const MAX_BITMAP_BYTES = 16 * 1024 * 1024

function byteIndex(seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`Invalid durable sequence: ${seq}`)
  const index = Math.floor(seq / 8)
  if (index >= MAX_BITMAP_BYTES) throw new Error(`Durable sequence exceeds sparse-compaction limit: ${seq}`)
  return index
}

export function isCompactedSequence(bitmap: Uint8Array | undefined, seq: number): boolean {
  if (!bitmap || !Number.isSafeInteger(seq) || seq < 0) return false
  const index = Math.floor(seq / 8)
  if (index >= bitmap.byteLength) return false
  return (bitmap[index] & (1 << (seq & 7))) !== 0
}

export function hasCompactedSequences(bitmap: Uint8Array | undefined): boolean {
  if (!bitmap) return false
  for (const byte of bitmap) if (byte !== 0) return true
  return false
}

export function mergeCompactedSequences(
  current: Uint8Array | undefined,
  sequences: ReadonlyArray<number>,
): { readonly bitmap: Uint8Array; readonly added: number; readonly grewBytes: number } {
  if (sequences.length === 0) {
    return { bitmap: current ? current.slice() : new Uint8Array(), added: 0, grewBytes: 0 }
  }
  let max = -1
  for (const seq of sequences) {
    byteIndex(seq)
    if (seq > max) max = seq
  }
  const required = byteIndex(max) + 1
  const before = current?.byteLength ?? 0
  const bitmap = new Uint8Array(Math.max(before, required))
  if (current) bitmap.set(current)
  let added = 0
  for (const seq of sequences) {
    const index = Math.floor(seq / 8)
    const mask = 1 << (seq & 7)
    if ((bitmap[index] & mask) !== 0) continue
    bitmap[index] = bitmap[index] | mask
    added++
  }
  return { bitmap, added, grewBytes: Math.max(0, bitmap.byteLength - before) }
}

export const loadCompaction = Effect.fn("ChunkDB.compaction.load")(function* (
  db: SqlExecutor,
  aggregateID: string,
) {
  return yield* db.get<{ bitmap: Uint8Array; count: number }>(sql`
    SELECT bitmap, compacted_count AS count
    FROM event_compaction
    WHERE aggregate_id = ${aggregateID}
  `)
})

/** Merge compacted sequence positions into the aggregate bitmap. Callers may
 * invoke this inside an existing SQLite transaction; one BLOB row is rewritten
 * regardless of how many event rows are compacted in the slice. */
export const recordCompactedSequences = Effect.fn("ChunkDB.compaction.record")(function* (
  db: SqlExecutor,
  aggregateID: string,
  sequences: ReadonlyArray<number>,
) {
  if (sequences.length === 0) return { added: 0, grewBytes: 0, bitmapBytes: 0 }
  // A maintenance pass can hold candidate sequences while another connection
  // deletes their aggregate (for example the local-data reset). Never create an
  // orphan bitmap after that delete. When called inside a write transaction this
  // check and the write share the same serialized SQLite writer epoch.
  const aggregate = yield* db.get<{ one: number }>(sql`
    SELECT 1 AS one FROM event_sequence WHERE aggregate_id = ${aggregateID} LIMIT 1
  `)
  if (!aggregate) return { added: 0, grewBytes: 0, bitmapBytes: 0 }
  const row = yield* loadCompaction(db, aggregateID)
  const merged = mergeCompactedSequences(row?.bitmap, sequences)
  yield* db.run(sql`
    INSERT INTO event_compaction (aggregate_id, bitmap, compacted_count, time_updated)
    VALUES (${aggregateID}, ${merged.bitmap}, ${(row?.count ?? 0) + merged.added}, ${Date.now()})
    ON CONFLICT(aggregate_id) DO UPDATE SET
      bitmap = excluded.bitmap,
      compacted_count = excluded.compacted_count,
      time_updated = excluded.time_updated
  `)
  return { added: merged.added, grewBytes: merged.grewBytes, bitmapBytes: merged.bitmap.byteLength }
})

/** Deterministic wire-only identity. It is deliberately outside the normal
 * ascending event-ID namespace so retransmission produces the exact same filler
 * identity without persisting one ID per compacted event. */
export function compactedWireID(aggregateID: string, seq: number): ReturnType<typeof Event.ID.make> {
  const digest = createHash("sha256").update(aggregateID).update("\0").update(String(seq)).digest("hex").slice(0, 32)
  return Event.ID.make(`evt_compacted_${digest}`)
}

export type SparseStoredEvent = {
  readonly id: ReturnType<typeof Event.ID.make>
  readonly aggregate_id: string
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

export function compactedWireEvent(aggregateID: string, seq: number): SparseStoredEvent {
  const id = compactedWireID(aggregateID, seq)
  return {
    id,
    aggregate_id: aggregateID,
    seq,
    type: CHECKPOINT_TYPE,
    // These fields are compatibility metadata only. Semantic provenance was
    // already proven before deletion; the bitmap intentionally does not retain
    // hundreds of thousands of superseded IDs. The filler is a durable no-op.
    data: { aggregateID, supersededType: "semantic.compacted", supersededBy: id },
  }
}

/**
 * Expand a sparse stored history into the existing contiguous replay protocol.
 * Every physical gap MUST be certified by the compaction bitmap. An unexplained
 * gap is corruption and fails closed rather than silently inventing history.
 */
export function inflateCompactedHistory<T extends SparseStoredEvent>(input: {
  readonly aggregateID: string
  readonly rows: ReadonlyArray<T>
  readonly bitmap?: Uint8Array
  readonly after?: number
  readonly through: number
}): Array<T | SparseStoredEvent> {
  const rows = [...input.rows].sort((a, b) => a.seq - b.seq)
  const output: Array<T | SparseStoredEvent> = []
  let expected = (input.after ?? -1) + 1
  for (const row of rows) {
    if (row.aggregate_id !== input.aggregateID) throw new Error(`Sparse history aggregate mismatch at seq ${row.seq}`)
    if (row.seq < expected) throw new Error(`Sparse history sequence regression at ${input.aggregateID}/${row.seq}`)
    while (expected < row.seq) {
      if (!isCompactedSequence(input.bitmap, expected)) {
        throw new Error(`Unexplained durable sequence gap at ${input.aggregateID}/${expected}`)
      }
      output.push(compactedWireEvent(input.aggregateID, expected))
      expected++
    }
    output.push(row)
    expected = row.seq + 1
  }
  while (expected <= input.through) {
    if (!isCompactedSequence(input.bitmap, expected)) {
      throw new Error(`Unexplained durable sequence gap at ${input.aggregateID}/${expected}`)
    }
    output.push(compactedWireEvent(input.aggregateID, expected))
    expected++
  }
  return output
}
