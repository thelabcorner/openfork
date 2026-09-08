import { createHash } from "node:crypto"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseShape } from "./database"
import {
  applyV5Correction,
  decodeV5Correction,
  decodeValueBytesObject,
  isV5Frame,
  parseV5Header,
} from "./json-codec"
import { decompressValueAsync } from "./decompress-pool"
import { Flag } from "../flag/flag"

/** Compact semantic classes stored in `event_semantic.kind`. */
export const SemanticKind = {
  Message: 1,
  Part: 2,
} as const

export type SemanticKind = (typeof SemanticKind)[keyof typeof SemanticKind]

export type SemanticIdentity = {
  readonly kind: SemanticKind
  readonly entityID: string
  readonly parentID?: string
}

type InternedEntity = {
  readonly entityKey: number
  readonly parentID?: string
}

const CDB_REF = "$cdbRef"
const decoder = new TextDecoder()
const INTERNED_ENTITY_CACHE_ENTRIES = 8_192

type InternCache = {
  readonly aggregates: Map<string, number>
  readonly entities: Map<string, InternedEntity>
}

const internCache = new WeakMap<object, InternCache>()

function cacheFor(db: object): InternCache {
  let cache = internCache.get(db)
  if (!cache) {
    cache = { aggregates: new Map(), entities: new Map() }
    internCache.set(db, cache)
  }
  return cache
}

function cacheEntity(cache: InternCache, key: string, value: InternedEntity) {
  if (cache.entities.size >= INTERNED_ENTITY_CACHE_ENTRIES && !cache.entities.has(key)) {
    const oldest = cache.entities.keys().next().value
    if (oldest !== undefined) cache.entities.delete(oldest)
  }
  cache.entities.delete(key)
  cache.entities.set(key, value)
}

export function semanticKind(type: string): SemanticKind | undefined {
  if (type === "message.updated" || type === "message.updated.1") return SemanticKind.Message
  if (type === "message.part.updated" || type === "message.part.updated.1") return SemanticKind.Part
  return undefined
}

/**
 * Extract semantic identity from an already-decoded durable event payload.
 * This is intentionally O(1): no JSON stringify/hash/parsing on the hot write
 * path. Only the two full-snapshot classes participate.
 */
export function semanticIdentity(type: string, data: unknown): SemanticIdentity | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const kind = semanticKind(type)
  if (kind === SemanticKind.Message) {
    const info = Reflect.get(data, "info")
    if (!info || typeof info !== "object" || Array.isArray(info)) return undefined
    const id = Reflect.get(info, "id")
    if (typeof id !== "string") return undefined
    return { kind: SemanticKind.Message, entityID: id }
  }

  if (kind === SemanticKind.Part) {
    const part = Reflect.get(data, "part")
    if (!part || typeof part !== "object" || Array.isArray(part)) return undefined
    const id = Reflect.get(part, "id")
    const messageID = Reflect.get(part, "messageID")
    if (typeof id !== "string" || typeof messageID !== "string") return undefined
    return { kind: SemanticKind.Part, entityID: id, parentID: messageID }
  }
  return undefined
}

function cdbRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const id = Reflect.get(value, CDB_REF)
  return typeof id === "string" ? id : undefined
}

async function decodeFrame(bytes: Uint8Array) {
  return Flag.OPENCODE_SEAL_WORKERS ? decompressValueAsync(bytes) : Promise.resolve(decodeValueBytesObject(bytes))
}

/** Decode one canonical event_value entry, including v5 delta chains, fail-closed. */
type ResolvedValue = { readonly value: unknown; readonly raw: Uint8Array }

function resolveValue(
  db: DatabaseShape,
  aggregateID: string,
  valueID: string,
  seen: ReadonlySet<string> = new Set(),
): Effect.Effect<ResolvedValue> {
  return Effect.gen(function* () {
    if (seen.has(valueID)) throw new Error(`ChunkDB semantic index: cyclic delta_ref at ${aggregateID}/${valueID}`)
    if (seen.size >= 16) throw new Error(`ChunkDB semantic index: delta_ref depth exceeded at ${aggregateID}/${valueID}`)
    const row = yield* db.get<{ bytes: Uint8Array; sha256: string }>(sql`
      SELECT bytes, sha256 FROM event_value
      WHERE aggregate_id = ${aggregateID} AND value_id = ${valueID}
    `).pipe(Effect.orDie)
    if (!row) throw new Error(`ChunkDB semantic index: missing event_value ${aggregateID}/${valueID}`)
    const bytes = row.bytes
    let raw: Uint8Array
    let value: unknown
    if (isV5Frame(bytes)) {
      const header = parseV5Header(bytes)
      const next = new Set(seen)
      next.add(valueID)
      const base = yield* resolveValue(db, aggregateID, header.baseValueId, next)
      const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
      raw = applyV5Correction(base.raw, correction, header.totalRawLen)
      value = JSON.parse(decoder.decode(raw))
    } else {
      const decoded = yield* Effect.promise(() => decodeFrame(bytes))
      raw = decoded.raw
      value = decoded.value
    }
    const actual = createHash("sha256").update(raw).digest("hex")
    if (actual !== row.sha256) throw new Error(`ChunkDB semantic index: sha256 mismatch for ${aggregateID}/${valueID}`)
    return { value, raw }
  })
}

/**
 * Decode event/projection storage regardless of its current ChunkDB
 * representation. Ordinary objects pass through. TEXT JSON parses directly;
 * `$cdbRef` resolves through event_value; inline BLOB frames decode with the
 * same CRC-checked codec as EventV2.
 */
export const decodeSemanticStorage = Effect.fn("ChunkDB.semantic.decodeStorage")(function* (
  db: DatabaseShape,
  aggregateID: string,
  stored: unknown,
) {
  if (typeof stored === "string") {
    const parsed = JSON.parse(stored) as unknown
    const ref = cdbRef(parsed)
    if (ref) return (yield* resolveValue(db, aggregateID, ref)).value
    return parsed
  }
  if (stored instanceof Uint8Array) return (yield* Effect.promise(() => decodeFrame(stored))).value
  return stored
})

export function semanticRef(stored: unknown): string | undefined {
  if (typeof stored !== "string" || stored.length > 512) return undefined
  try {
    return cdbRef(JSON.parse(stored))
  } catch {
    return undefined
  }
}

const internAggregate = Effect.fn("ChunkDB.semantic.internAggregate")(function* (
  db: DatabaseShape,
  aggregateID: string,
) {
  const cache = cacheFor(db)
  const cached = cache.aggregates.get(aggregateID)
  if (cached !== undefined) return cached

  const inserted = yield* db.get<{ aggregateKey: number }>(sql`
    INSERT INTO semantic_aggregate (aggregate_id)
    VALUES (${aggregateID})
    ON CONFLICT(aggregate_id) DO NOTHING
    RETURNING aggregate_key AS aggregateKey
  `).pipe(Effect.orDie)
  const aggregateKey =
    inserted?.aggregateKey ??
    (yield* db.get<{ aggregateKey: number }>(sql`
      SELECT aggregate_key AS aggregateKey
      FROM semantic_aggregate
      WHERE aggregate_id = ${aggregateID}
    `).pipe(Effect.orDie))?.aggregateKey
  if (aggregateKey === undefined) throw new Error(`ChunkDB semantic index: failed to intern aggregate ${aggregateID}`)
  cache.aggregates.set(aggregateID, aggregateKey)
  return aggregateKey
})

const internEntity = Effect.fn("ChunkDB.semantic.internEntity")(function* (
  db: DatabaseShape,
  aggregateKey: number,
  identity: SemanticIdentity,
) {
  const cache = cacheFor(db)
  const cacheKey = `${aggregateKey}\0${identity.kind}\0${identity.entityID}`
  const cached = cache.entities.get(cacheKey)
  if (cached) {
    cache.entities.delete(cacheKey)
    cache.entities.set(cacheKey, cached)
    // A part id is expected to have one immutable parent message. The legacy
    // projector does not update message_id on conflict, so a same-id/different-
    // parent event must fail closed instead of receiving a provenance bit.
    if (identity.kind === SemanticKind.Part && cached.parentID !== identity.parentID) return undefined
    return cached.entityKey
  }

  const inserted = yield* db.get<{ entityKey: number; parentID: string | null }>(sql`
    INSERT INTO semantic_entity (aggregate_key, kind, entity_id, parent_id)
    VALUES (${aggregateKey}, ${identity.kind}, ${identity.entityID}, ${identity.parentID ?? null})
    ON CONFLICT(aggregate_key, kind, entity_id) DO NOTHING
    RETURNING entity_key AS entityKey, parent_id AS parentID
  `).pipe(Effect.orDie)
  const row =
    inserted ??
    (yield* db.get<{ entityKey: number; parentID: string | null }>(sql`
      SELECT entity_key AS entityKey, parent_id AS parentID
      FROM semantic_entity
      WHERE aggregate_key = ${aggregateKey}
        AND kind = ${identity.kind}
        AND entity_id = ${identity.entityID}
    `).pipe(Effect.orDie))
  if (!row) throw new Error(`ChunkDB semantic index: failed to intern entity ${identity.entityID}`)
  const value = { entityKey: row.entityKey, parentID: row.parentID ?? undefined }
  cacheEntity(cache, cacheKey, value)
  if (identity.kind === SemanticKind.Part && value.parentID !== identity.parentID) return undefined
  return value.entityKey
})

/**
 * Persist semantic identity atomically with the durable event. This runs AFTER
 * the durable projector succeeded and before the surrounding SQLite transaction
 * commits, so `proven=1` is a provenance certificate: the authoritative
 * projection was produced by this exact snapshot sequence. No payload hash or
 * stringify is needed on the hot write path.
 */
export const indexSemanticEvent = Effect.fn("ChunkDB.semantic.indexEvent")(function* (
  db: DatabaseShape,
  input: {
    readonly aggregateID: string
    readonly seq: number
    readonly type: string
    readonly data: Record<string, unknown>
  },
) {
  const identity = semanticIdentity(input.type, input.data)
  if (!identity) return false
  const aggregateKey = yield* internAggregate(db, input.aggregateID)
  const entityKey = yield* internEntity(db, aggregateKey, identity)
  if (entityKey === undefined) return false
  yield* db.run(sql`
    INSERT INTO event_semantic (aggregate_key, seq, kind, entity_key, proven)
    VALUES (${aggregateKey}, ${input.seq}, ${identity.kind}, ${entityKey}, 1)
    ON CONFLICT(aggregate_key, seq) DO UPDATE SET
      kind = excluded.kind,
      entity_key = excluded.entity_key,
      proven = 1
  `).pipe(Effect.orDie)
  return true
})
