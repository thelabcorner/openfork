import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { FileIndex } from "@opencode-ai/core/filesystem/index"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { IndexSerialization } from "@opencode-ai/core/filesystem/index-serialization"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { ChunkStore, KIND_DIR, KIND_FILE } from "@opencode-ai/core/search/chunk-store"
import { tmpdir } from "../fixture/fixture"

const cachePathFor = (dataDir: string, dir: string) => path.join(dataDir, "file-index", `${Hash.sha256(dir)}.json`)
const dbPathFor = (dataDir: string, dir: string) => ChunkStore.dbPathFor(dir, dataDir)

const write = (dir: string, name: string, content = "") => Effect.promise(() => Bun.write(path.join(dir, name), content))

const enc = (p: string) => new TextEncoder().encode(p)

const rp = (p: string) => RelativePath.make(p as RelativePath)

const paths = (entries: readonly { path: string }[]) => entries.map((entry) => String(entry.path))

/** Build a focused FileIndex layer bound to `dir`, with a temp Global data dir. */
const withIndex = <A, E>(dir: string, dataDir: string, effect: Effect.Effect<A, E, FileIndex.Service>) =>
  effect.pipe(
    Effect.provide(
      LayerNode.compile(
        LayerNode.group([FileIndex.node]),
        [
          [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(dir) }))],
          [
            Global.node,
            makeGlobalNode({ service: Global.Service, layer: Global.layerWith({ data: dataDir }), deps: [] }),
          ],
        ],
      ),
    ),
  )

describe("FileIndex", () => {
  test("cold build lists children and persists a decodable blob", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "a")
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src/b.ts"), "b")
      },
    })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        console.log("FI===FS:", FileIndex.Service === (FileSystem.Service as unknown), "FI===W:", FileIndex.Service === (Watcher.Service as unknown))
        const entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("a.txt")
        expect(paths(entries)).toContain("src/")

        yield* index.flush()
        // Unified SQLite persistence: FileIndex now writes `fileIndex` meta
        // into `file-index/<hash>.db`, not a standalone JSON file.
        const dbPath = dbPathFor(data.path, tmp.path)
        const chunkStore = yield* Effect.gen(function* () {
          const store = yield* ChunkStore.Service
          return yield* store.getMeta("fileIndex")
        }).pipe(Effect.provide(ChunkStore.layerFromPath(dbPath)), Effect.scoped)
        expect(chunkStore).toBeDefined()
        const bytes = new TextEncoder().encode(chunkStore!)
        const blob = yield* IndexSerialization.decode(bytes)
        expect(blob.subtrees[""].entries.map((e) => String(e.path))).toContain("a.txt")
        expect(blob.subtrees["src"].entries.map((e) => String(e.path))).toContain("src/b.ts")
        // Legacy JSON should have been cleaned up
        const legacyExists = yield* Effect.promise(() =>
          fs
            .stat(cachePathFor(data.path, tmp.path))
            .then(() => true)
            .catch(() => false),
        )
        expect(legacyExists).toBe(false)
      })),
    )
  })

  test("serves sub-children from the index", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src/b.ts"), "b")
      },
    })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        yield* index.list(rp(""))
        const children = yield* index.list(rp("src"))
        expect(paths(children)).toContain("src/b.ts")
      })),
    )
  })

  test("incremental patch applies put and delete to a cached subtree", async () => {
    await using tmp = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "a.txt"), "a") })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        yield* index.list(rp(""))

        yield* index.applyPatch({ op: "put", dir: "", entry: { path: rp("new.txt"), type: "file" } })
        let entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("new.txt")

        yield* index.applyPatch({ op: "delete", dir: "", entryPath: "new.txt" })
        entries = yield* index.list(rp(""))
        expect(paths(entries)).not.toContain("new.txt")
      })),
    )
  })

  test("invalidate drops a subtree so the next list re-scans", async () => {
    await using tmp = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "a.txt"), "a") })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        yield* index.list(rp(""))

        yield* write(tmp.path, "b.txt", "b")
        yield* index.invalidate("")
        const entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("b.txt")
      })),
    )
  })

  test("freshness invalidation rebuilds when the root stat changes", async () => {
    await using tmp = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "a.txt"), "a") })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        let entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("a.txt")

        // Adding a file to the root changes the root dir mtime -> stale -> rebuild.
        yield* write(tmp.path, "b.txt", "b")
        entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("b.txt")
      })),
    )
  })

  test("search-chunk hydrate drops paths deleted while the process was stopped", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "kept.txt"), "kept")
        await fs.mkdir(path.join(dir, "ghost"))
        await Bun.write(path.join(dir, "ghost", "inner.txt"), "inner")
      },
    })
    await using data = await tmpdir()

    // Simulate the pre-existing state that caused this bug: a search index
    // written by an EARLIER process, plus a directory deleted while no
    // FileIndex was running. No watcher event ever fires for the deletion, so
    // there is no tombstone — only the search chunks name the ghost path.
    const dbPath = dbPathFor(data.path, tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ChunkStore.Service
        yield* store.append([
          { kind: KIND_FILE, entries: [enc("kept.txt"), enc("ghost/inner.txt")] },
          { kind: KIND_DIR, entries: [enc("ghost")] },
        ])
      }).pipe(
        Effect.provide(ChunkStore.layerFromPath(dbPath)),
        Effect.scoped,
        Effect.orDie,
      ),
    )
    await fs.rm(path.join(tmp.path, "ghost"), { recursive: true, force: true })

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        const root = yield* index.list(rp(""))
        expect(paths(root)).toContain("kept.txt")
        expect(paths(root)).not.toContain("ghost/")

        // A nested directory hydrated the same way is confirmed on its own
        // first list, not just the root.
        const nested = yield* index.list(rp("ghost"))
        expect(paths(nested)).toEqual([])
      })),
    )
  })

  test("atomic write leaves no temp files and a valid blob", async () => {
    await using tmp = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "a.txt"), "a") })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        yield* index.list(rp(""))
        yield* index.flush()

        const dir = path.dirname(dbPathFor(data.path, tmp.path))
        const files = yield* Effect.promise(() => fs.readdir(dir))
        expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
        expect(files).toContain(path.basename(dbPathFor(data.path, tmp.path)))
        // No legacy JSON should remain
        expect(files).not.toContain(path.basename(cachePathFor(data.path, tmp.path)))
      })),
    )
  })

  test("loads a pre-existing index from disk without re-scanning", async () => {
    await using tmp = await tmpdir()
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        // Write a cache blob manually whose entry does NOT exist on disk. If the
        // index loads from disk (fresh rootStat), list("") returns the ghost entry
        // without re-scanning the filesystem.
        const stat = yield* Effect.promise(() => fs.stat(tmp.path))
        const blob = IndexSerialization.encode({
          schemaVersion: 1,
          builtAt: Date.now(),
          root: tmp.path,
          rootStat: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
          subtrees: {
            "": { at: Date.now(), entries: [{ path: rp("ghost.txt"), type: "file" }] },
          },
        })
        yield* Effect.promise(() => fs.mkdir(path.dirname(cachePathFor(data.path, tmp.path)), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(cachePathFor(data.path, tmp.path), blob))

        const index = yield* FileIndex.Service
        const entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("ghost.txt")
      })),
    )
  })
})
