/**
 * ChunkDB benchmark + prototype race harness (median-3).
 *
 * RACES candidates and reports the winner with concrete evidence:
 *   1. Codec race: zstd-1 vs zstd-3 vs brotli-q1  (compress/dec MB/s + ratio)
 *   2. Worker race: sync vs worker-pool (compress + decompress MB/s)
 *   3. Jumbo race: 32MiB payload — sync vs pool decompress (latency + parallelism)
 *   4. End-to-end: baseline (plain TEXT) vs ChunkDB (framed + dedup) —
 *      DB size, promotion throughput, rehydration p99, dedup ratio.
 *
 * Run: bun run test/bench-chunkdb.ts   (relative paths only)
 */
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync, statSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Database as CoreDatabase, Service as DatabaseService } from "../src/database/database"
import type { DatabaseShape } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { ensureChunkDB } from "../src/database/chunkdb"
import { runPassV2 } from "../src/database/chunk-sealer"
import { rehydrateEvents } from "../src/event"
import { compressText, decompressFrame, decodeValueBytesRaw } from "../src/database/json-codec"
import { compressTextAsync, compressPoolClose } from "../src/database/compress-pool"
import { decompressValueAsync, decompressPoolClose } from "../src/database/decompress-pool"
import { EventTable, EventSequenceTable, EventValueTable } from "../src/event/sql"
import { sql } from "drizzle-orm"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Minimal Database layer for the bench: identical pragmas + migrations +
// ensureChunkDB as the real layer, but WITHOUT the forked sealer loop — so the
// bench can call runPassV2 directly without racing the loop's immediate pass.
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const benchLayer = (filename: string) =>
  Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* ensureChunkDB(db)
      return { db, filename }
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      sqliteLayer({
        filename,
        createTimePragmas: { page_size: 8192, auto_vacuum: 2 },
      }),
    ),
  )

// ---- payload generation -------------------------------------------------
function makePayload(targetBytes: number, seed: number): Record<string, unknown> {
  const unit = "The quick brown fox jumps over the lazy dog. ".repeat(8)
  const reps = Math.max(1, Math.floor(targetBytes / (unit.length * 2)))
  return {
    type: "session-message",
    sessionID: `sess_${seed % 50}`,
    index: seed,
    content: Array.from({ length: reps }, (_, i) => ({ role: "user", i, text: unit })),
  }
}

// ---- timing helpers ------------------------------------------------------
function median3(times: number[]): number {
  const s = [...times].sort((a, b) => a - b)
  return s[1]
}
function mbPerSec(bytes: number, sec: number): number {
  return bytes / 1e6 / Math.max(sec, 1e-9)
}
async function time3(fn: () => unknown | Promise<unknown>): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await fn()
    times.push((performance.now() - t0) / 1000)
  }
  return median3(times)
}

// ---- 1. CODEC RACE -------------------------------------------------------
async function codecRace() {
  const sizes = [8_000, 32_000, 128_000]
  const payloads = sizes.flatMap((sz) => Array.from({ length: 40 }, (_, i) => encoder.encode(JSON.stringify(makePayload(sz, i)))))
  const totalBytes = payloads.reduce((a, p) => a + p.byteLength, 0)
  const codecs = [
    { name: "zstd-1", codec: 1 as const, level: 1 },
    { name: "zstd-3", codec: 1 as const, level: 3 },
    { name: "brotli-1", codec: 2 as const, level: 1 },
  ]
  console.log("\n=== 1. CODEC RACE (median-3, mixed 8/32/128KiB) ===")
  const results: Array<{ name: string; cMBps: number; dMBps: number; ratio: number }> = []
  for (const c of codecs) {
    const comp = await time3(() => {
      for (const p of payloads) compressText(decoder.decode(p), { codec: c.codec, level: c.level })
    })
    const frames = payloads.map((p) => compressText(decoder.decode(p), { codec: c.codec, level: c.level }) as Uint8Array)
    const dec = await time3(() => {
      for (const f of frames) decompressFrame(f)
    })
    const frameBytes = frames.reduce((a, f) => a + f.byteLength, 0)
    const r = { name: c.name, cMBps: mbPerSec(totalBytes, comp), dMBps: mbPerSec(totalBytes, dec), ratio: totalBytes / frameBytes }
    results.push(r)
    console.log(`  ${c.name.padEnd(8)} compress ${r.cMBps.toFixed(0)} MB/s | decompress ${r.dMBps.toFixed(0)} MB/s | ratio ${r.ratio.toFixed(2)}x`)
  }
  const bestRatio = results.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  const bestDec = results.reduce((a, b) => (b.dMBps > a.dMBps ? b : a))
  console.log(`  WINNER ratio: ${bestRatio.name} | WINNER decode: ${bestDec.name}`)
}

// ---- 2. WORKER RACE ------------------------------------------------------
async function workerRace() {
  const payloads = Array.from({ length: 200 }, (_, i) => JSON.stringify(makePayload(32_000, i)))
  const totalBytes = payloads.reduce((a, p) => a + encoder.encode(p).byteLength, 0)
  console.log("\n=== 2. WORKER RACE (median-3, 200 x 32KiB) ===")
  const syncC = await time3(() => {
    for (const p of payloads) compressText(p)
  })
  const poolC = await time3(async () => {
    await Promise.all(payloads.map((p) => compressTextAsync(p)))
  })
  const frames = payloads.map((p) => compressText(p) as Uint8Array)
  const syncD = await time3(() => {
    for (const f of frames.length ? frames : []) decompressFrame(f)
  })
  const poolD = await time3(async () => {
    await Promise.all(frames.map((f) => decompressValueAsync(f)))
  })
  console.log(`  compress  sync ${mbPerSec(totalBytes, syncC).toFixed(0)} MB/s | pool ${mbPerSec(totalBytes, poolC).toFixed(0)} MB/s  (${((mbPerSec(totalBytes, poolC) / mbPerSec(totalBytes, syncC))).toFixed(2)}x)`)
  console.log(`  decompress sync ${mbPerSec(totalBytes, syncD).toFixed(0)} MB/s | pool ${mbPerSec(totalBytes, poolD).toFixed(0)} MB/s  (${((mbPerSec(totalBytes, poolD) / mbPerSec(totalBytes, syncD))).toFixed(2)}x)`)
}

// ---- 3. JUMBO RACE -------------------------------------------------------
async function jumboRace() {
  const jumbo = JSON.stringify(makePayload(32_000_000, 1))
  const frame = compressText(jumbo) as Uint8Array
  console.log("\n=== 3. JUMBO RACE (32MiB payload) ===")
  console.log(`  raw ${encoder.encode(jumbo).byteLength} B -> frame ${frame.byteLength} B (${(encoder.encode(jumbo).byteLength / frame.byteLength).toFixed(1)}x)`)
  // Fair comparison: the pool does decompress (worker) + parse (main), so the
  // sync baseline must do the SAME total work (decompress + parse), not just
  // decompressFrame (which skips the parse the caller needs).
  const sync1 = await time3(() => {
    const raw = decodeValueBytesRaw(frame)
    JSON.parse(decoder.decode(raw))
  })
  const pool1 = await time3(async () => decompressValueAsync(frame))
  console.log(`  single decode+parse: sync ${sync1 * 1000 | 0} ms | pool ${pool1 * 1000 | 0} ms`)
  // Parallelism: 16 jumbos at once
  const N = 16
  const syncN = await time3(async () => {
    for (let i = 0; i < N; i++) {
      const raw = decodeValueBytesRaw(frame)
      JSON.parse(decoder.decode(raw))
    }
  })
  const poolN = await time3(async () => {
    await Promise.all(Array.from({ length: N }, () => decompressValueAsync(frame)))
  })
  console.log(`  ${N} jumbos: sync ${syncN * 1000 | 0} ms (serial) | pool ${poolN * 1000 | 0} ms (parallel)  -> ${(syncN / poolN).toFixed(2)}x faster`)
}

// ---- 4. END-TO-END -------------------------------------------------------
async function endToEnd() {
  const dir = mkdtempSync(join(tmpdir(), "chunkdb-bench-"))
  const baselinePath = join(dir, "baseline.sqlite")
  const chunkPath = join(dir, "chunk.sqlite")
  const N = 2000
  const AGG = 50
  // 30% of events share 5 repeated payloads (dedup fodder); rest unique.
  const repeated = Array.from({ length: 5 }, (_, i) => makePayload(32_000, 1000 + i))
  const events: Array<{ id: string; agg: string; seq: number; data: Record<string, unknown> }> = []
  for (let i = 0; i < N; i++) {
    const agg = `agg_${i % AGG}`
    const data = i % 10 < 3 ? repeated[i % 5] : makePayload([8000, 32000, 128000][i % 3], i)
    events.push({ id: `evt_${i}`, agg, seq: i + 1, data })
  }

  console.log("\n=== 4. END-TO-END (2000 events / 50 aggregates, 30% repeated) ===")

  // Baseline: plain TEXT, no flags.
  process.env.OPENCODE_SEAL_ENABLED = "0"
  process.env.OPENCODE_SEAL_DEDUP = "0"
  const baseline = await runE2E(baselinePath, events, false)
  console.log(`  BASELINE   size ${(baseline.size / 1e6).toFixed(1)} MB | insert ${baseline.insertMs | 0} ms`)

  // ChunkDB: flags on.
  process.env.OPENCODE_SEAL_ENABLED = "1"
  process.env.OPENCODE_SEAL_DEDUP = "1"
  process.env.OPENCODE_SEAL_WORKERS = "1"
  const chunk = await runE2E(chunkPath, events, true)
  console.log(`  CHUNKDB    size ${(chunk.size / 1e6).toFixed(1)} MB | insert ${chunk.insertMs | 0} ms | promote ${chunk.promoteMs | 0} ms (${((N / (chunk.promoteMs / 1000)) | 0)} rows/s)`)
  console.log(`  compression: ${(baseline.size / chunk.size).toFixed(2)}x smaller | dedup: ${chunk.eventRows} events -> ${chunk.valueRows} event_value rows (${(100 * (1 - chunk.valueRows / chunk.eventRows)).toFixed(1)}% collapse)`)
  console.log(`  rehydration p99: ${chunk.rehydrateP99 | 0} us (byte-exact: ${chunk.byteExact}) | freelist ${chunk.freelist} pages | wal ${(chunk.walSize / 1e6).toFixed(1)} MB`)

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows keeps the DB file locked while the layer is open; best-effort.
  }
}

async function runE2E(
  path: string,
  events: Array<{ id: string; agg: string; seq: number; data: Record<string, unknown> }>,
  seal: boolean,
) {
  const layer = benchLayer(path)
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseService
      // event_sequence rows (owner_id NULL so the sealer selects them).
      const aggSeq = new Map<string, number>()
      for (const e of events) aggSeq.set(e.agg, Math.max(aggSeq.get(e.agg) ?? 0, e.seq))
      yield* db.insert(EventSequenceTable).values(
        Array.from(aggSeq, ([aggregate_id, seq]) => ({ aggregate_id, seq, owner_id: null })),
      ).onConflictDoNothing().run().pipe(Effect.orDie)
      const t0 = performance.now()
      yield* db.insert(EventTable).values(
        events.map((e) => ({ id: e.id as never, aggregate_id: e.agg, seq: e.seq, type: "bench.event", data: e.data })),
      ).run().pipe(Effect.orDie)
      const insertMs = performance.now() - t0

      let promoteMs = 0
      let valueRows = 0
      if (seal) {
        const tp = performance.now()
        yield* runPassV2(db)
        promoteMs = performance.now() - tp
        const vr = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM event_value`).pipe(Effect.orDie)
        valueRows = vr[0]?.c ?? 0
      }

      // Rehydration p99 over all aggregates (read path).
      const perAgg = Array.from(aggSeq.keys())
      const latencies: number[] = []
      let byteExact = true
      for (const agg of perAgg) {
        const rows = yield* db.select().from(EventTable).where(sql`aggregate_id = ${agg}`).all().pipe(Effect.orDie)
        const t0 = performance.now()
        const hydrated = yield* rehydrateEvents(db, agg, rows as never)
        latencies.push((performance.now() - t0) / rows.length * 1000)
        for (let i = 0; i < rows.length; i++) {
          const orig = events.find((e) => e.id === (rows[i] as { id: string }).id)!
          if (JSON.stringify((hydrated[i] as { data: unknown }).data) !== JSON.stringify(orig.data)) byteExact = false
        }
      }
      latencies.sort((a, b) => a - b)
      const rehydrateP99 = latencies[Math.floor(latencies.length * 0.99)] ?? latencies[latencies.length - 1]

      const size = statSync(path).size
      let freelist = 0
      let walSize = 0
      if (seal) {
        // The real layer checkpoints the WAL every 5 min; do it here so the
        // measured size is the steady-state on-disk size, not the uncheckpointed
        // promote transaction.
        yield* db.run(`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.orDie)
        const fl = yield* db.all<{ freelist_count: number }>(`PRAGMA freelist_count`).pipe(Effect.orDie)
        freelist = fl[0]?.freelist_count ?? 0
        try {
          walSize = statSync(`${path}-wal`).size
        } catch {
          walSize = 0
        }
      }
      return { size, insertMs, promoteMs, valueRows, eventRows: events.length, rehydrateP99, byteExact, freelist, walSize }
    }).pipe(Effect.provide(layer)),
  )
}

async function main() {
  await codecRace()
  await workerRace()
  await jumboRace()
  await endToEnd()
  await compressPoolClose()
  await decompressPoolClose()
  console.log("\n=== DONE ===")
}
main().catch((e) => {
  console.error("BENCH FAIL")
  const walk = (err: unknown, depth: number): string => {
    if (!err || depth > 5) return ""
    const obj = err as Record<string, unknown>
    const parts: string[] = []
    for (const k of ["message", "code", "constraint", "query", "operation"]) {
      if (obj[k] !== undefined) parts.push(`${k}=${JSON.stringify(obj[k])}`)
    }
    const cause = obj.cause
    if (cause && typeof cause === "object") parts.push(`cause={${walk(cause, depth + 1)}}`)
    return parts.join(" ")
  }
  console.error(walk(e, 0))
  process.exit(1)
})
