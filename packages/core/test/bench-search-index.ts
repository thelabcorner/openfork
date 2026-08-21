// Search-index gate bench (indexer lane, optimization loop).
// Run: bun test/bench-search-index.ts [corpusJsonPath]
// Gates: warm load < 50ms @185k | partial load < 5ms | seal 1k < 100ms
//        storage ratio >= 25x on real corpus | corrupt-CRC fail-closed
import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
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
console.log(`corpus: ${corpus.length.toLocaleString()} paths, ${((rawBytes / 1048576)).toFixed(2)} MiB raw`)

await Effect.runPromise(((Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(ChunkStore.layerFromPath(dbFile) as Layer.Layer<ChunkStore.Service>)
      const store = Context.get(ctx as any, ChunkStore.Service)

    // --- seal: chunk + append the whole corpus ---
    const sorted = corpus.map((p) => new TextEncoder().encode(p)).sort(compareBytes)
    const chunks: { kind: number; entries: Uint8Array[] }[] = []
    for (let i = 0; i < sorted.length; i += 8192) chunks.push({ kind: ChunkStore.KIND_FILE, entries: sorted.slice(i, i + 8192) })
    const sealAllMs = yield* Effect.promise(async () => {
      const t0 = performance.now()
      await Effect.runPromise(store.append(chunks) as any)
      return performance.now() - t0
    })
    console.log(`seal-all (${chunks.length} chunks): ${sealAllMs.toFixed(1)}ms`)

    // --- gate: seal of 1k pending ---
    const pending1k = sorted.slice(0, 1000)
    const seal1k = median(
      yield* Effect.promise(async () => {
        const samples: number[] = []
        for (let run = 0; run < 5; run++) {
          const t0 = performance.now()
          await Effect.runPromise(store.append([{ kind: ChunkStore.KIND_DIR, entries: pending1k }]) as any)
          samples.push(performance.now() - t0)
        }
        return samples
      }),
    )
    console.log(`GATE seal-1k: ${seal1k.toFixed(1)}ms (target < 100ms)`)

    // --- gate: warm load (raw scan, bytes only) ---
    const rawLoad = median(
      yield* Effect.promise(async () => {
        const samples: number[] = []
        for (let run = 0; run < 5; run++) {
          const t0 = performance.now()
          const raw = (await Effect.runPromise(store.readRaw(ChunkStore.KIND_FILE) as any)) as ChunkStore.RawChunk[]
          let total = 0
          for (const chunk of raw) total += chunk.count
          samples.push(performance.now() - t0 + (total === 0 ? 1 : 0))
        }
        return samples
      }),
    )
    console.log(`GATE warm-load(raw bytes): ${rawLoad.toFixed(1)}ms (target < 50ms)`)

    // --- gate: warm load (full string materialization, current hot-set model) ---
    const fullLoad = median(
      yield* Effect.promise(async () => {
        const samples: number[] = []
        for (let run = 0; run < 5; run++) {
          const t0 = performance.now()
          const decoded = await Effect.runPromise(store.readAll(ChunkStore.KIND_FILE) as any)
          let total = 0
          for (const chunk of decoded as ChunkStore.StoredChunk[]) total += chunk.paths.length
          samples.push(performance.now() - t0 + (total === 0 ? 1 : 0))
        }
        return samples
      }),
    )
    console.log(`GATE warm-load(full strings): ${fullLoad.toFixed(1)}ms (target < 50ms)`)

    // --- gate: partial load (first 2 chunks via SQL range) ---
    const partialDb = new Database(dbFile)
    const partial = median([1, 2, 3].map(() =>
      timeMs(() => {
        const rows = partialDb.query("SELECT raw_len, crc, data FROM idx_chunk WHERE kind = 0 AND seq < 2 ORDER BY seq").all() as any[]
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
    ))
    partialDb.close()
    console.log(`GATE partial-load(first 2 chunks ≈ ${(2 * 8192).toLocaleString()} entries): ${partial.toFixed(1)}ms (target < 5ms)`)

    // --- gate: storage ratio (clean DB: corpus chunks only) ---
    const ratioDb = path.join(dir, "ratio.db")
    yield* Effect.gen(function* () {
      const ctx = yield* Layer.build(ChunkStore.layerFromPath(ratioDb) as Layer.Layer<ChunkStore.Service>)
      const s = Context.get(ctx as any, ChunkStore.Service)
      yield* s.append(chunks)
    })
    yield* Effect.promise(() => new Promise<void>((resolve) => {
      const db = new Database(ratioDb)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      db.close()
      resolve()
    }))
    const dbSize = fs.statSync(ratioDb).size
    const ratio = rawBytes / dbSize
    console.log(`GATE storage-ratio: ${ratio.toFixed(1)}x (target >= 25x), db=${(dbSize / 1048576).toFixed(2)} MiB`)

    // --- gate: corrupt-CRC fail-closed ---
    const tamper = new Database(dbFile)
    const row = tamper.query("SELECT seq, data FROM idx_chunk WHERE kind = 0 ORDER BY seq LIMIT 1").get() as any
    const bad = Uint8Array.from(row.data)
    bad[bad.length - 1]! ^= 0xff
    tamper.query("UPDATE idx_chunk SET data = ? WHERE seq = ?").run(bad, row.seq)
    tamper.close()
    const exit = yield* Effect.exit(store.readAll(ChunkStore.KIND_FILE) as any)
    console.log(`GATE corrupt-CRC fail-closed: ${Effect.isFailure(exit) ? "PASS" : "FAIL"}`)
    }),
  ))) as unknown as Effect.Effect<void, never>)

fs.rmSync(dir, { recursive: true, force: true })

