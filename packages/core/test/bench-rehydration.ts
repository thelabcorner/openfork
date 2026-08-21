/**
 * Epoch-3 rehydration read-path benchmark (ANVIL-informed).
 *
 * Exercises the fused single-pass decode + hot-value (refs-weighted) cache end
 * to end through EventV2.readAggregate, on a realistic dedup-heavy workload:
 *   - N events (default 1000) referencing M unique payloads (default 500), so
 *     each unique payload is shared by ~2 events (dedup).
 *   - One payload is given a very high `refs` count to prove the hot set stays
 *     pre-decoded while a generic LRU would evict it under churn.
 *
 * Reports: cold (cache-miss) vs warm (cache-hit) events/sec, p99 latency, LRU
 * hit rate, and a fused-vs-non-fused decode micro-bench delta.
 *
 * Run: bun run packages/core/test/bench-rehydration.ts
 * (throwaway harness — not a *.test.ts, so it is excluded from `bun test`.)
 */
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { EventV2, rehydrateCacheStats, resetRehydrateCacheStats, REHYDRATE_CACHE_CAP_ENTRIES } from "../src/event"
import { Event } from "@opencode-ai/schema/event"
import { Database as CoreDatabase } from "../src/database/database"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { compressText, decodeValueBytes, decodeValueBytesObject } from "../src/database/json-codec"

process.env.OPENCODE_SEAL_DEDUP = "1"

const N_EVENTS = Number(process.env.BENCH_N ?? 1000)
const M_UNIQUE = Number(process.env.BENCH_M ?? 500)
const ITERS = Number(process.env.BENCH_ITERS ?? 20)
const encoder = new TextEncoder()

function makePayload(i: number) {
  return {
    type: "session-message",
    sessionID: `sess_${i}`,
    content: Array.from({ length: 200 }, (_, k) => ({
      role: "user",
      index: k,
      text: `The quick brown fox jumps over the lazy dog. ${i} ${k}`.repeat(12),
    })),
  }
}

const ChunkEvent = EventV2.define({
  type: "bench.chunk",
  durable: { version: 1, aggregate: "aggregateID" },
  schema: { aggregateID: Schema.String, payload: Schema.Unknown },
})
const manifest = { definitions: Event.durable([ChunkEvent]), schema: ChunkEvent }

const dbLayer = CoreDatabase.layerFromPath(":memory:")
const EVENT_VALUE_DDL = `CREATE TABLE IF NOT EXISTS event_value (
  aggregate_id TEXT NOT NULL,
  value_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  raw_len INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  refs INTEGER NOT NULL DEFAULT 1,
  time_promoted INTEGER NOT NULL,
  PRIMARY KEY (aggregate_id, value_id),
  UNIQUE (aggregate_id, sha256),
  FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
)`

function p99(times: Array<number>): number {
  const sorted = [...times].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))
  return sorted[idx]
}

function fusedDecodeMicroBench(bytes: Uint8Array): { fusedNs: number; nonFusedNs: number; speedup: number } {
  // warmup
  for (let i = 0; i < 200; i++) {
    decodeValueBytesObject(bytes)
    JSON.parse(decodeValueBytes(bytes))
  }
  // fused: decode + parse + sha256 over raw bytes (no re-encode)
  let fIters = 0
  let fStart = process.hrtime.bigint()
  let fTime = 0n
  while (fTime < 200_000_000n) {
    const { raw } = decodeValueBytesObject(bytes)
    createHash("sha256").update(raw).digest("hex")
    fIters++
    fTime = process.hrtime.bigint() - fStart
  }
  // non-fused: decode -> string -> re-encode -> sha256 (the old path's cost)
  let nIters = 0
  let nStart = process.hrtime.bigint()
  let nTime = 0n
  while (nTime < 200_000_000n) {
    const text = decodeValueBytes(bytes)
    createHash("sha256").update(encoder.encode(text)).digest("hex")
    nIters++
    nTime = process.hrtime.bigint() - nStart
  }
  const fusedNs = Number(fTime) / fIters
  const nonFusedNs = Number(nTime) / nIters
  return { fusedNs, nonFusedNs, speedup: nonFusedNs / fusedNs }
}

function bench() {
  return Effect.gen(function* () {
    const { db } = yield* CoreDatabase.Service
    yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)

    const aggID = "bench_agg"
    yield* db
      .insert(EventSequenceTable)
      .values({ aggregate_id: aggID, seq: N_EVENTS, owner_id: null })
      .run()
      .pipe(Effect.orDie)

    const type = EventV2.versionedType("bench.chunk", 1)
    const events: Array<{ id: EventV2.ID; aggregate_id: string; seq: number; type: string; data: Record<string, unknown> }> = []
    const valueRows: Array<{
      aggregate_id: string
      value_id: string
      sha256: string
      raw_len: number
      bytes: Uint8Array
      refs: number
      time_promoted: number
    }> = []
    const seen = new Map<number, string>()

    // One "hot" payload referenced by many events (high refs => stays cached).
    const HOT_REFS = 200
    const hotValueID = `${aggID}:hot`
    const hotPayload = makePayload(0)
    const hotRaw = JSON.stringify({ aggregateID: aggID, payload: hotPayload })
    const hotSha = createHash("sha256").update(hotRaw, "utf8").digest("hex")
    const hotFrame = compressText(hotRaw)
    const hotStored = typeof hotFrame === "string" ? encoder.encode(hotFrame) : hotFrame
    valueRows.push({
      aggregate_id: aggID,
      value_id: hotValueID,
      sha256: hotSha,
      raw_len: hotRaw.length,
      bytes: hotStored,
      refs: HOT_REFS,
      time_promoted: Date.now(),
    })

    for (let i = 0; i < N_EVENTS; i++) {
      const u = i % M_UNIQUE
      let valueID: string
      if (u === 0) {
        // Slot 0 maps to the hot payload (referenced HOT_REFS times total).
        valueID = hotValueID
      } else {
        const existing = seen.get(u)
        if (existing === undefined) {
          const payload = makePayload(u)
          const raw = JSON.stringify({ aggregateID: aggID, payload: payload })
          const sha = createHash("sha256").update(raw, "utf8").digest("hex")
          const frame = compressText(raw)
          const stored = typeof frame === "string" ? encoder.encode(frame) : frame
          valueID = `${aggID}:${u}`
          seen.set(u, valueID)
          valueRows.push({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: sha,
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
        } else {
          valueID = existing
        }
      }
      events.push({ id: EventV2.ID.create(), aggregate_id: aggID, seq: i + 1, type, data: { $cdbRef: valueID } })
    }

    yield* db.insert(EventTable).values(events).run().pipe(Effect.orDie)
    for (const v of valueRows) {
      yield* db
        .run(
          sql`INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
              VALUES (${v.aggregate_id}, ${v.value_id}, ${v.sha256}, ${v.raw_len}, ${v.bytes}, ${v.refs}, ${v.time_promoted})`,
        )
        .pipe(Effect.orDie)
    }

    const readAll = () => EventV2.readAggregate(db, { aggregateID: aggID, limit: N_EVENTS + 1, manifest })

    // Cold read: populates the hot-value cache (all misses, fused decode).
    resetRehydrateCacheStats(db)
    const coldStart = process.hrtime.bigint()
    yield* readAll()
    const coldNs = Number(process.hrtime.bigint() - coldStart)
    const coldStats = rehydrateCacheStats(db)

    // Warm reads: cache hits (zero decompress + zero JSON.parse).
    resetRehydrateCacheStats(db)
    const times: Array<number> = []
    for (let i = 0; i < ITERS; i++) {
      const start = process.hrtime.bigint()
      yield* readAll()
      times.push(Number(process.hrtime.bigint() - start))
    }
    const warmStats = rehydrateCacheStats(db)
    const meanNs = times.reduce((a, b) => a + b, 0) / times.length
    const coldEventsPerSec = N_EVENTS / (coldNs / 1e9)
    const warmEventsPerSec = N_EVENTS / (meanNs / 1e9)
    const warmHitRate = warmStats.hits / (warmStats.hits + warmStats.misses || 1)

    // Fused-decode micro-bench on a representative frame.
    const sampleFrame = compressText(JSON.stringify(makePayload(7)))
    const sampleBytes = typeof sampleFrame === "string" ? encoder.encode(sampleFrame) : sampleFrame
    const micro = fusedDecodeMicroBench(sampleBytes)

    console.log(`\n=== Epoch-3 rehydration bench ===`)
    console.log(`N=${N_EVENTS} events, M=${M_UNIQUE} unique payloads, hot refs=${HOT_REFS}, iters=${ITERS}`)
    console.log(`metric                 | cold         | warm`)
    console.log(`-----------------------+--------------+--------------`)
    console.log(`events/sec             | ${coldEventsPerSec.toFixed(0).padStart(12)} | ${warmEventsPerSec.toFixed(0).padStart(12)}`)
    console.log(`read latency (ms)      | ${(coldNs / 1e6).toFixed(2).padStart(12)} | ${(meanNs / 1e6).toFixed(2).padStart(12)}`)
    console.log(`p99 latency (ms)       | ${"n/a".padStart(12)} | ${(p99(times) / 1e6).toFixed(2).padStart(12)}`)
    console.log(`cache hit rate         | ${(coldStats.hits / (coldStats.hits + coldStats.misses || 1) * 100).toFixed(1)}%`.padEnd(23) + `| ${(warmHitRate * 100).toFixed(1)}%`)
    console.log(`cache hits/misses      | ${coldStats.hits}/${coldStats.misses}`.padEnd(23) + `| ${warmStats.hits}/${warmStats.misses}`)
    console.log(`cache entries (cap ${REHYDRATE_CACHE_CAP_ENTRIES})`.padEnd(23) + `| ${coldStats.entries}`.padEnd(14) + `| ${warmStats.entries}`)
    console.log(`\n=== Fused single-pass decode (ANVIL M) micro-bench ===`)
    console.log(`fused   : ${micro.fusedNs.toFixed(1)} ns/op (decode+parse+sha256 over raw bytes)`)
    console.log(`non-fused: ${micro.nonFusedNs.toFixed(1)} ns/op (decode+parse+sha256 over re-encoded string)`)
    console.log(`speedup : ${micro.speedup.toFixed(2)}x`)
  }).pipe(Effect.provide(dbLayer))
}

Effect.runPromise(bench()).catch((e) => {
  console.error(e)
  process.exit(1)
})
