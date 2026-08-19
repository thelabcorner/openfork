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
import { tmpdir } from "../fixture/fixture"

const cachePathFor = (dataDir: string, dir: string) => path.join(dataDir, "file-index", `${Hash.sha256(dir)}.json`)

const write = (dir: string, name: string, content = "") => Effect.promise(() => Bun.write(path.join(dir, name), content))

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
        console.log("FI===FS:", FileIndex.Service === FileSystem.Service, "FI===W:", FileIndex.Service === Watcher.Service)
        const entries = yield* index.list(rp(""))
        expect(paths(entries)).toContain("a.txt")
        expect(paths(entries)).toContain("src/")

        yield* index.flush()
        const bytes = yield* Effect.promise(() => fs.readFile(cachePathFor(data.path, tmp.path)))
        const blob = yield* IndexSerialization.decode(bytes)
        expect(blob.subtrees[""].entries.map((e) => String(e.path))).toContain("a.txt")
        expect(blob.subtrees["src"].entries.map((e) => String(e.path))).toContain("src/b.ts")
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

  test("atomic write leaves no temp files and a valid blob", async () => {
    await using tmp = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "a.txt"), "a") })
    await using data = await tmpdir()

    await Effect.runPromise(
      withIndex(tmp.path, data.path, Effect.gen(function* () {
        const index = yield* FileIndex.Service
        yield* index.list(rp(""))
        yield* index.flush()

        const dir = path.dirname(cachePathFor(data.path, tmp.path))
        const files = yield* Effect.promise(() => fs.readdir(dir))
        expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
        expect(files).toContain(path.basename(cachePathFor(data.path, tmp.path)))
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
