import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Option } from "effect"
import { SearchIndex } from "@opencode-ai/core/search/index-service"
import { ChunkStore } from "@opencode-ai/core/search/chunk-store"
import { Location } from "@opencode-ai/core/location"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { EventV2 } from "@opencode-ai/core/event"
import { RelativePath } from "@opencode-ai/core/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { tmpdir } from "./fixture/tmpdir"

// Deterministic seed fixture instead of spawning rg: the stub feeds the same
// entry shape the real Ripgrep.Service.find would.
const makeLayer = (
  directory: string,
  dataDir: string,
  seededFiles: string[],
  options?: { statGate?: Promise<void>; onRead?: () => void; seedGate?: Promise<void>; onSeed?: () => void },
) =>
  SearchIndex.layerWith(ChunkStore.dbPathFor(directory, dataDir)).pipe(
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: AbsolutePath.make(directory),
          project: { id: Project.ID.make("test-project"), directory: AbsolutePath.make(directory) },
        }),
      ),
    ),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ data: dataDir }))),
    Layer.provide(
      Layer.succeed(
        Ripgrep.Service,
        Ripgrep.Service.of({
          find: (input) =>
            input.onEntry
              ? Effect.gen(function* () {
                  options?.onSeed?.()
                  if (options?.seedGate) yield* Effect.promise(() => options.seedGate!)
                  yield* Effect.forEach(seededFiles, (file) =>
                    input.onEntry!({ path: RelativePath.make(file), type: "file" }),
                  )
                  return []
                })
              : Effect.succeed([]),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        }),
      ),
    ),
    // Watcher events are not exercised here; only the subscription is consumed.
    Layer.provide(
      Layer.succeed(EventV2.Service, {
        listen: () => Effect.succeed(() => {}),
        listenLocation: () => Effect.succeed(() => {}),
      } as unknown as EventV2.Interface),
    ),
    Layer.provide(
      Layer.succeed(FSUtil.Service, {
        realPath: (target: string) => Effect.succeed(target),
        isDir: () => Effect.succeed(false),
        stat: () =>
          (options?.statGate ? Effect.promise(() => options.statGate!) : Effect.void).pipe(
            Effect.as({
              size: 100,
              mtime: Option.some(new Date()),
              ino: Option.some(0),
              type: "File",
            } as any),
          ),
        readFileStringSafe: () => {
          options?.onRead?.()
          return Effect.succeed("a\nb\nc")
        },
      } as unknown as FSUtil.Interface),
    ),
  )

const pollUntil = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(50)
  }
  return false
}

type Snapshot = { paths: SearchIndex.PathEntry[]; symbols: never[] }
const load = (index: SearchIndex.Interface) => Effect.runPromise(index.loadAll() as Effect.Effect<Snapshot>)
const run = (effect: Effect.Effect<void, unknown, unknown>) =>
  Effect.runPromise(effect as Effect.Effect<void, unknown, never>)

describe("SearchIndex", () => {
  test("seeds files and first-class directories, seals, removes, compacts", async () => {
    const tmp = await tmpdir()
    try {
      const layer = makeLayer(tmp.path, path.join(tmp.path, "data"), [
        "src/alpha.ts",
        "src/components/button.tsx",
        "README.md",
      ])
      // Provide wraps the WHOLE body: a per-yield provide would scope the
      // store's connection to that single expression.
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service

          // Seed is awaited during layer build; snapshot is complete.
          const seeded = yield* Effect.promise(() => pollUntil(async () => (await load(index)).paths.length >= 5))
          expect(seeded).toBe(true)
          const byPath = new Map((yield* Effect.promise(() => load(index))).paths.map((entry) => [entry.path, entry]))
          expect(byPath.get("src/alpha.ts")?.isDir).toBe(false)
          expect(byPath.get("src/components/button.tsx")?.isDir).toBe(false)
          // Ancestor directories are first-class index entries.
          expect(byPath.get("src")?.isDir).toBe(true)
          expect(byPath.get("src/components")?.isDir).toBe(true)

          yield* index.upsert({ path: "src/beta.ts", isDir: false })
          yield* index.remove("README.md")
          yield* index.seal()
          const after = yield* Effect.promise(() => load(index))
          const afterByPath = new Map(after.paths.map((entry) => [entry.path, entry]))
          expect(afterByPath.has("src/beta.ts")).toBe(true)
          expect(afterByPath.has("README.md")).toBe(false)

          // Compaction rewrites without loss.
          yield* index.compact()
          const compacted = yield* Effect.promise(() => load(index))
          expect(compacted.paths.length).toBe(after.paths.length)
          expect(new Set(compacted.paths.map((entry) => entry.path))).toEqual(
            new Set(after.paths.map((entry) => entry.path)),
          )
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("persists across reopen from the same project db", async () => {
    const tmp = await tmpdir()
    try {
      const dataDir = path.join(tmp.path, "data")
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const seeded = yield* Effect.promise(() => pollUntil(async () => (await load(index)).paths.length >= 3))
          expect(seeded).toBe(true)
          yield* index.seal()
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, ["one.ts", "dir/two.ts"])), Effect.scoped),
      )

      // Second instance over the same db: the freshness marker is recent, so no
      // authoritative walk and no reseed; the persisted base loads as-is.
      let walks = 0
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const all = yield* Effect.promise(() => load(index))
          const paths = new Set(all.paths.map((entry) => entry.path))
          expect(paths.has("one.ts")).toBe(true)
          expect(paths.has("dir/two.ts")).toBe(true)
          expect(paths.has("dir")).toBe(true)
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, [], { onSeed: () => walks++ })), Effect.scoped),
      )
      // Negative invariant: a fresh index must not re-enumerate the tree.
      expect(walks).toBe(0)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("reconciles stale persisted paths written while unwatched", async () => {
    const tmp = await tmpdir()
    try {
      const dataDir = path.join(tmp.path, "data")
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const seeded = yield* Effect.promise(() => pollUntil(async () => (await load(index)).paths.length >= 2))
          expect(seeded).toBe(true)
          yield* index.seal()
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, ["old/one.ts"])), Effect.scoped),
      )

      // Age the freshness marker so the next open performs an authoritative
      // reconciliation instead of trusting the persisted base chunks.
      await run(
        Effect.gen(function* () {
          const store = yield* ChunkStore.Service
          yield* store.putMeta("indexedAt", String(Date.now() - SearchIndex.RECONCILE_TTL_MS - 1_000))
        }).pipe(
          Effect.provide(ChunkStore.layerFromPath(ChunkStore.dbPathFor(tmp.path, dataDir))),
          Effect.scoped,
        ),
      )

      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const paths = new Set((yield* Effect.promise(() => load(index))).paths.map((entry) => entry.path))
          // The moved/created path is authoritative again...
          expect(paths.has("new/two.ts")).toBe(true)
          expect(paths.has("new")).toBe(true)
          // ...and the ghost directory/files that no longer exist are gone.
          expect(paths.has("old/one.ts")).toBe(false)
          expect(paths.has("old")).toBe(false)
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, ["new/two.ts"])), Effect.scoped),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("reconcile compacts a fragmented store", async () => {
    const tmp = await tmpdir()
    try {
      const dataDir = path.join(tmp.path, "data")
      const seededFiles = ["src/seed.ts", ...Array.from({ length: 70 }, (_, i) => `src/file-${i}.ts`)]
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const seeded = yield* Effect.promise(() => pollUntil(async () => (await load(index)).paths.length >= 2))
          expect(seeded).toBe(true)
          // Simulate watcher deltas: one sealed chunk per edit.
          for (let i = 0; i < 70; i++) {
            yield* index.upsert({ path: `src/file-${i}.ts`, isDir: false })
            yield* index.seal()
          }
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, ["src/seed.ts"])), Effect.scoped),
      )

      const countChunks = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* ChunkStore.Service
            return yield* store.count()
          }).pipe(
            Effect.provide(ChunkStore.layerFromPath(ChunkStore.dbPathFor(tmp.path, dataDir))),
            Effect.scoped,
          ),
        )

      expect(await countChunks()).toBeGreaterThan(30)

      // Age the marker so the next open reconciles and rewrites the fragments.
      await run(
        Effect.gen(function* () {
          const store = yield* ChunkStore.Service
          yield* store.putMeta("indexedAt", String(Date.now() - SearchIndex.RECONCILE_TTL_MS - 1_000))
        }).pipe(
          Effect.provide(ChunkStore.layerFromPath(ChunkStore.dbPathFor(tmp.path, dataDir))),
          Effect.scoped,
        ),
      )

      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const paths = new Set((yield* Effect.promise(() => load(index))).paths.map((entry) => entry.path))
          for (const file of seededFiles) expect(paths.has(file)).toBe(true)
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, seededFiles)), Effect.scoped),
      )

      // The reconcile rewrote the delta chunks into a bounded base.
      expect(await countChunks()).toBeLessThan(10)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("concurrent hosts elect one cold seeder for the shared project db", async () => {
    const tmp = await tmpdir()
    try {
      const dataDir = path.join(tmp.path, "data")
      const seededFiles = ["src/one.ts", "src/two.ts", "README.md"]
      let seedCalls = 0
      let releaseSeed!: () => void
      const seedGate = new Promise<void>((resolve) => {
        releaseSeed = resolve
      })
      const options = {
        seedGate,
        onSeed: () => seedCalls++,
      }

      const host = () =>
        run(
          Effect.gen(function* () {
            const index = yield* SearchIndex.Service
            const all = yield* Effect.promise(() => load(index))
            expect(all.paths.filter((entry) => !entry.isDir)).toHaveLength(seededFiles.length)
          }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, seededFiles, options)), Effect.scoped),
        )

      const first = host()
      const second = host()
      expect(await pollUntil(async () => seedCalls === 1, 2_000)).toBe(true)
      // Give the contender enough time to reach the DB-local lease. It must not
      // execute the ripgrep stub while the elected owner is still blocked.
      await Bun.sleep(200)
      expect(seedCalls).toBe(1)
      releaseSeed()
      await Promise.all([first, second])
      expect(seedCalls).toBe(1)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("bulk metadata hydration never blocks structural search readiness", async () => {
    const tmp = await tmpdir()
    try {
      const seededFiles = Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`)
      let releaseStat!: () => void
      const statGate = new Promise<void>((resolve) => {
        releaseStat = resolve
      })
      let reads = 0
      let bodyReachedAt = Number.POSITIVE_INFINITY
      const started = performance.now()
      // Safety release means a regression fails by latency rather than hanging
      // the test until Bun's outer timeout.
      const safety = setTimeout(() => releaseStat(), 1_500)

      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          bodyReachedAt = performance.now()
          const all = yield* Effect.promise(() => load(index))
          expect(all.paths.filter((entry) => !entry.isDir)).toHaveLength(seededFiles.length)

          // If metadata were still collected inline, this body could not be
          // reached until statGate opened.
          releaseStat()
          const hydrated = yield* Effect.promise(() =>
            pollUntil(async () => index.fileMetadata("src/file-0.ts") !== undefined),
          )
          expect(hydrated).toBe(true)
          // Bulk hydration is stat-only: line-count file reads are reserved for
          // tiny watcher batches, not a whole-repository cold start.
          expect(reads).toBe(0)
        }).pipe(
          Effect.provide(
            makeLayer(tmp.path, path.join(tmp.path, "data"), seededFiles, {
              statGate,
              onRead: () => reads++,
            }),
          ),
          Effect.scoped,
        ),
      )
      clearTimeout(safety)
      expect(bodyReachedAt - started).toBeLessThan(1_000)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 10_000)
})
