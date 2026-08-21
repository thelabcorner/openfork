import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { ChunkStore } from "@opencode-ai/core/search/chunk-store"
import { compareBytes } from "@opencode-ai/core/search/front-code"
import { tmpdir } from "./fixture/tmpdir"

const mulberry = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const CHUNK_ENTRIES = 8192

function randomSortedPaths(count: number): Uint8Array[] {
  const rand = mulberry(7)
  const words = ["src", "lib", "core", "node", "tree", "leaf", "index", "chunk", "store", "search"]
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const segs = 1 + ((rand() * 4) | 0)
    const parts: string[] = []
    for (let s = 0; s < segs; s++) parts.push(words[(rand() * words.length) | 0]!)
    paths.push(parts.join("/") + "/" + String(i) + ".ts")
  }
  return paths.map((p) => new TextEncoder().encode(p)).sort(compareBytes)
}

const withStore = <A, E>(tmpPath: string, body: (store: ChunkStore.Interface) => Effect.Effect<A, E>, filename = path.join(tmpPath, "file-index", "idx.db")) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore.Service
    return yield* body(store)
  }).pipe(Effect.provide(ChunkStore.layerFromPath(filename)), Effect.scoped)

describe("ChunkStore", () => {
  test("meta roundtrips and upserts", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withStore(tmp.path, (store) =>
            Effect.gen(function* () {
              expect(yield* store.getMeta("root")).toBeUndefined()
              yield* store.putMeta("root", "/tmp/project")
              yield* store.putMeta("schemaVersion", ChunkStore.SCHEMA_VERSION)
              yield* store.putMeta("root", "/tmp/project-v2")
              expect(yield* store.getMeta("root")).toBe("/tmp/project-v2")
              expect(yield* store.getMeta("schemaVersion")).toBe(ChunkStore.SCHEMA_VERSION)
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  test("append + readAll roundtrips a multi-chunk corpus", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withStore(tmp.path, (store) =>
            Effect.gen(function* () {
              const all = randomSortedPaths(20_000)
              const chunks: ChunkStore.ChunkInput[] = []
              for (let i = 0; i < all.length; i += CHUNK_ENTRIES)
                chunks.push({ kind: ChunkStore.KIND_FILE, entries: all.slice(i, i + CHUNK_ENTRIES) })
              yield* store.append(chunks)

              expect(yield* store.count()).toBe(chunks.length)
              const read = yield* store.readAll(ChunkStore.KIND_FILE)
              expect(read.length).toBe(chunks.length)
              const flattened = read.flatMap((chunk) => chunk.paths)
              expect(flattened.length).toBe(all.length)
              expect(flattened).toEqual(all.map((entry) => new TextDecoder().decode(entry)))
              for (let i = 0; i < read.length; i++) expect(read[i]!.count).toBe(chunks[i]!.entries.length)
              const raw = yield* store.readRaw(ChunkStore.KIND_FILE)
              expect(raw.map((chunk) => chunk.count)).toEqual(chunks.map((chunk) => chunk.entries.length))
              expect(yield* store.decodeChunk(raw[0]!.seq)).toEqual(read[0]!.paths)
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  test("directories are a separate first-class stream", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withStore(tmp.path, (store) =>
            Effect.gen(function* () {
              const files = randomSortedPaths(50)
              const dirs = ["src", "src/components", "src/components/buttons"]
                .map((p) => new TextEncoder().encode(p))
                .sort(compareBytes)
              yield* store.append([
                { kind: ChunkStore.KIND_FILE, entries: files },
                { kind: ChunkStore.KIND_DIR, entries: dirs },
              ])
              expect((yield* store.readAll(ChunkStore.KIND_DIR)).flatMap((chunk) => chunk.paths)).toEqual(
                dirs.map((entry) => new TextDecoder().decode(entry)),
              )
              expect((yield* store.readAll(ChunkStore.KIND_FILE)).flatMap((chunk) => chunk.paths)).toHaveLength(50)
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  test("readAll fails closed on a corrupted chunk payload", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* withStore(tmp.path, (store) =>
              Effect.gen(function* () {
                const entries = randomSortedPaths(100)
                yield* store.append([{ kind: ChunkStore.KIND_FILE, entries }])
              }),
            )

            // Tamper with the stored BLOB behind the store's back after the
            // writer connection has been closed.
            const dbFile = path.join(tmp.path, "file-index", "idx.db")
            const raw = new Database(dbFile)
            const row = raw.query("SELECT seq, data FROM idx_chunk ORDER BY seq LIMIT 1").get() as {
              seq: number
              data: Uint8Array
            }
            const tampered = Uint8Array.from(row.data)
            tampered[tampered.length - 1]! ^= 0xff
            raw.query("UPDATE idx_chunk SET data = ? WHERE seq = ?").run(tampered, row.seq)
            raw.close()

            const exit = yield* Effect.exit(withStore(tmp.path, (store) => store.readAll(ChunkStore.KIND_FILE)))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const rendered = String(exit.cause)
              expect(rendered).toMatch(/CRC mismatch|frame error|front-code/)
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  test("clear removes chunk rows but keeps meta", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withStore(tmp.path, (store) =>
            Effect.gen(function* () {
              yield* store.putMeta("root", "/tmp/project")
              yield* store.append([{ kind: ChunkStore.KIND_FILE, entries: randomSortedPaths(10) }])
              expect(yield* store.count()).toBe(1)
              yield* store.clear()
              expect(yield* store.count()).toBe(0)
              expect((yield* store.readAll(ChunkStore.KIND_FILE)).length).toBe(0)
              expect(yield* store.getMeta("root")).toBe("/tmp/project")
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  test("db file lands under a sha256-named path and survives reopen", async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const dbFile = ChunkStore.dbPathFor("/tmp/project", tmp.path)
            expect(path.dirname(dbFile)).toBe(path.join(tmp.path, "file-index"))
            expect(path.basename(dbFile)).toMatch(/^[0-9a-f]{64}\.db$/)
            yield* withStore(tmp.path, (store) => store.putMeta("digest", "abc"), dbFile)
            expect(yield* Effect.promise(() => fs.stat(dbFile))).toBeTruthy()
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })
})
