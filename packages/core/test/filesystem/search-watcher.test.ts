import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
    OPENCODE_DISABLE_FFF: "true",
  }),
)

function provide(directory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Watcher.node, FileSystemSearch.node]), [
      [Config.node, configLayer],
      [Location.node, locationLayer],
    ]).pipe(Layer.provide(flagsLayer)),
  )
}

async function run<R, T>(program: (directory: string) => Effect.Effect<T, never, R>) {
  const tmp = await tmpdir()
  try {
    return await Effect.runPromise(
      program(tmp.path).pipe(provide(tmp.path)) as unknown as Effect.Effect<T>,
    )
  } finally {
    await fs.rm(tmp.path, { recursive: true, force: true })
  }
}

function eventually<A>(check: (result: A) => boolean, effect: Effect.Effect<A, never, never>): Effect.Effect<A, never, never> {
  return effect.pipe(
    Effect.flatMap((result) =>
      check(result)
        ? Effect.succeed(result)
        : Effect.sleep("100 millis").pipe(Effect.andThen(() => eventually(check, effect))),
    ),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(new Error("timed out waiting for search index update")),
    }),
  )
}

describeWatcher("FileSystemSearch (ripgrepLayer) watcher feed", () => {
  test("adds new files and dirs via watcher events (non-git root, untracked)", async () => {
    const files = await run((directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        yield* Effect.sleep("300 millis")
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "chat.ts"), "export const chat = 1\n"))
        return yield* eventually(
          (result) => result.some((entry) => entry.path === RelativePath.make("src/chat.ts")),
          search.find({ query: "chat" }),
        )
      }),
    )
    expect(files.some((entry) => entry.path === RelativePath.make("src/chat.ts"))).toBe(true)
  })

  test("dirs stay mentionable: new dir appears via watcher events", async () => {
    const dirs = await run((directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        yield* Effect.sleep("300 millis")
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "chat.ts"), "export const chat = 1\n"))
        return yield* eventually(
          (result) => result.some((entry) => entry.path === RelativePath.make("src" + path.sep)),
          search.find({ query: "src", type: "directory" }),
        )
      }),
    )
    expect(dirs.some((entry) => entry.path === RelativePath.make("src" + path.sep))).toBe(true)
  })

  test("removes deleted files and prunes empty dirs", async () => {
    const removed = await run((directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        yield* Effect.sleep("300 millis")
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "chat.ts"), "export const chat = 1\n"))
        yield* eventually(
          (result) => result.some((entry) => entry.path === RelativePath.make("src/chat.ts")),
          search.find({ query: "chat" }),
        )
        yield* Effect.promise(() => fs.rm(path.join(directory, "src", "chat.ts")))
        const gone = yield* eventually(
          (result) => !result.some((entry) => entry.path === RelativePath.make("src/chat.ts")),
          search.find({ query: "chat" }),
        )
        const dirs = yield* eventually(
          (result) => !result.some((entry) => entry.path === RelativePath.make("src" + path.sep)),
          search.find({ query: "src", type: "directory" }),
        )
        expect(gone).toHaveLength(0)
        expect(dirs.some((entry) => entry.path === RelativePath.make("src" + path.sep))).toBe(false)
      }),
    )
    expect(removed).toBeUndefined()
  })

  test("ignores hidden files like the rg seed", async () => {
    const result = await run((directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        yield* Effect.sleep("300 millis")
        yield* Effect.promise(() => fs.writeFile(path.join(directory, ".env"), "SECRET=1\n"))
        yield* Effect.sleep("1 second")
        return yield* search.find({ query: "SECRET" })
      }),
    )
    expect(result.some((entry) => entry.path === RelativePath.make(".env"))).toBe(false)
  })
})
