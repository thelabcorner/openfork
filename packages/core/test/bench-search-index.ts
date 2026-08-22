// Search-index gate bench (indexer lane, optimization loop).
// Run: bun test/bench-search-index.ts [corpusJsonPath]
// Gates: time-to-searchable raw load < 50ms @185k | partial load < 5ms
//        seal 1k < 100ms | storage ratio >= 25x | corrupt-CRC fail-closed
import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { zstdDecompressSync } from "node:zlib"
import { ChunkStore } from "../src/search/chunk-store"
import { compareBytes, crc32, frontDecode } from "../src/search/front-code"

const REAL = process.argv[2] ?? "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"

const median = (xs: number[]) => xs.sort((a, b) => a - b)[(xs.length / 2) | 0]!
const timeMs = (fn: () => unknown) => {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

function loadCorpus(): string[] {
  const doc = JSON.parse(fs.readFileSync(REAL, "utf8"))
  const out: string[] = []
  for (const tree of Object.values<any>(doc.subtrees)) for (const e of tree.entries) out.push(e.path)
  return out
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-bench-"))
const dbFile = path.join(dir, "idx.db")

const corpus = loadCorpus()
const rawBytes = corpus.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0)
console.log(`corpus: ${corpus.length.toLocaleString()} paths, ${(rawBytes / 1048576).toFixed(2)} MiB raw`)

const program = Effect.gen(function* () {
  const store = yield* ChunkStore.Service

  // --- seal: chunk + append the whole corpus ---
  const sorted = corpus.map((p) => new TextEncoder().encode(p)).sort(compareBytes)
  const chunks: ChunkStore.ChunkInput[] = []
  for (let i = 0; i < sorted.length; i += 8192)
    chunks.push({ kind: ChunkStore.KIND_FILE, entries: sorted.slice(i, i + 8192) })
  let t0 = performance.now()
  yield* store.append(chunks)
  console.log(`seal-all (${chunks.length} chunks): ${(performance.now() - t0).toFixed(1)}ms`)

  // --- gate: seal of 1k pending ---
  const pending1k = sorted.slice(0, 1000)
  const sealSamples: number[] = []
  for (let run = 0; run < 5; run++) {
    t0 = performance.now()
    yield* store.append([{ kind: ChunkStore.KIND_DIR, entries: pending1k }])
    sealSamples.push(performance.now() - t0)
  }
  console.log(`GATE seal-1k: ${median(sealSamples).toFixed(1)}ms (target < 100ms)`)

  // --- gate: warm load (raw scan, bytes only) ---
  const rawSamples: number[] = []
  for (let run = 0; run < 5; run++) {
    t0 = performance.now()
    const raw = yield* store.readRaw(ChunkStore.KIND_FILE)
    let total = 0
    for (const chunk of raw) total += chunk.count
    rawSamples.push(performance.now() - t0 + (total === 0 ? 1 : 0))
  }
  console.log(`GATE warm-load(raw bytes): ${median(rawSamples).toFixed(1)}ms (target < 50ms)`)

  // --- gate: warm load (full string materialization) ---
  const fullSamples: number[] = []
  for (let run = 0; run < 5; run++) {
    t0 = performance.now()
    const decoded = yield* store.readAll(ChunkStore.KIND_FILE)
    let total = 0
    for (const chunk of decoded) total += chunk.paths.length
    fullSamples.push(performance.now() - t0 + (total === 0 ? 1 : 0))
  }
  console.log(`GATE warm-load(full strings): ${median(fullSamples).toFixed(1)}ms (target < 50ms)`)

  // --- gate: partial load (first 2 chunks via SQL range) ---
  const partialDb = new Database(dbFile)
  const partial = median(
    [1, 2, 3].map(() =>
      timeMs(() => {
        const rows = partialDb.query("SELECT raw_len, crc, data FROM idx_chunk WHERE kind = 0 AND seq < 2 ORDER BY seq").all() as Array<{ raw_len: number; crc: number; data: Uint8Array }>
        let n = 0
        for (const row of rows) {
          if (crc32(row.data) !== row.crc) throw new Error("crc")
          // stored payload may be an OCDB frame — decompress before parsing
          const isFrame = row.data[0] === 0x4f && row.data[1] === 0x43 && row.data[2] === 0x44 && row.data[3] === 0x42
          const raw = isFrame ? zstdDecompressSync(row.data.subarray(14)) : row.data
          // payload = varint(entryCount) ++ front-coded body
          let v = 0
          let shift = 0
          let p = 0
          for (;;) {
            const b = raw[p++]!
            v |= (b & 0x7f) << shift
            if (!(b & 0x80)) break
            shift += 7
          }
          n += frontDecode(raw.subarray(p), v).length
        }
        return n
      }),
    ),
  )
  partialDb.close()
  console.log(`GATE partial-load(first 2 chunks ≈ ${(2 * 8192).toLocaleString()} entries): ${partial.toFixed(1)}ms (target < 5ms)`)

  // --- gate: storage ratio (clean DB: corpus chunks only) ---
  const ratioDb = path.join(dir, "ratio.db")
  yield* Effect.gen(function* () {
    const s = yield* ChunkStore.Service
    yield* s.append(chunks)
  }).pipe(Effect.provide(ChunkStore.layerFromPath(ratioDb)), Effect.scoped)
  yield* Effect.promise(() => {
    const db = new Database(ratioDb)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    return Promise.resolve()
  })
  const dbSize = fs.statSync(ratioDb).size
  console.log(`GATE storage-ratio: ${(rawBytes / dbSize).toFixed(1)}x (target >= 25x), db=${(dbSize / 1048576).toFixed(2)} MiB`)

  // --- gate: corrupt-CRC fail-closed ---
  const tamper = new Database(dbFile)
  const row = tamper.query("SELECT seq, data FROM idx_chunk WHERE kind = 0 ORDER BY seq LIMIT 1").get() as { seq: number; data: Uint8Array }
  const bad = Uint8Array.from(row.data)
  bad[bad.length - 1]! ^= 0xff
  tamper.query("UPDATE idx_chunk SET data = ? WHERE seq = ?").run(bad, row.seq)
  tamper.close()
  const exit = yield* Effect.exit(store.readAll(ChunkStore.KIND_FILE))
  console.log(`GATE corrupt-CRC fail-closed: ${Effect.isFailure(exit) ? "PASS" : "FAIL"}`)
}).pipe(Effect.provide(ChunkStore.layerFromPath(dbFile)), Effect.scoped)

await Effect.runPromise(program)

fs.rmSync(dir, { recursive: true, force: true })
