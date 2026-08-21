import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
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
const makeLayer = (directory: string, dataDir: string, seededFiles: string[]) =>
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
              ? Effect.forEach(seededFiles, (file) => input.onEntry!({ path: RelativePath.make(file), type: "file" })).pipe(
                  Effect.as([]),
                )
              : Effect.succeed([]),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        }),
      ),
    ),
    // Watcher events are not exercised here; only listen() is consumed.
    Layer.provide(
      Layer.succeed(EventV2.Service, {
        listen: () => Effect.succeed(() => {}),
      } as unknown as EventV2.Interface),
    ),
    Layer.provide(
      Layer.succeed(FSUtil.Service, {
        realPath: (target: string) => Effect.succeed(target),
        isDir: () => Effect.succeed(false),
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
const run = (effect: Effect.Effect<void, unknown, unknown>) => Effect.runPromise(effect as Effect.Effect<void, unknown, never>)

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

      // Second instance over the same db: no reseed (chunks exist), base loads.
      await run(
        Effect.gen(function* () {
          const index = yield* SearchIndex.Service
          const all = yield* Effect.promise(() => load(index))
          const paths = new Set(all.paths.map((entry) => entry.path))
          expect(paths.has("one.ts")).toBe(true)
          expect(paths.has("dir/two.ts")).toBe(true)
          expect(paths.has("dir")).toBe(true)
        }).pipe(Effect.provide(makeLayer(tmp.path, dataDir, [])), Effect.scoped),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 20_000)
})
