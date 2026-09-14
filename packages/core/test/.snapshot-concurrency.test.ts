import { $ } from "bun"
import { describe } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("snapshot concurrency probe", () => {
  testEffect(Layer.empty).live(
    "measures six captures sharing one native shadow index",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              const files = Array.from({ length: 1_500 }, (_, index) =>
                fs.writeFile(path.join(project, `file-${index}.txt`), `base ${index}\n`),
              )
              await Promise.all(files)
              await $`git init`.cwd(project).quiet()
              await $`git config core.fsmonitor false`.cwd(project).quiet()
              await $`git config commit.gpgsign false`.cwd(project).quiet()
              await $`git config user.email test@opencode.test`.cwd(project).quiet()
              await $`git config user.name Test`.cwd(project).quiet()
              await $`git add .`.cwd(project).quiet()
              await $`git commit -m initial`.cwd(project).quiet()
            })

            const layer = AppNodeBuilder.build(Snapshot.node, [
              [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
              [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
            ])
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              yield* snapshot.capture()
              yield* Effect.promise(() =>
                Promise.all(
                  Array.from({ length: 300 }, (_, index) =>
                    fs.writeFile(path.join(project, `file-${index}.txt`), `changed ${index}\n`),
                  ),
                ),
              )
              const started = performance.now()
              const times = yield* Effect.all(
                Array.from({ length: 6 }, (_, lane) =>
                  Effect.gen(function* () {
                    const at = performance.now()
                    const tree = yield* snapshot.capture()
                    return { lane, ms: performance.now() - at, tree }
                  }),
                ),
                { concurrency: "unbounded" },
              )
              console.log(
                "[snapshot-concurrency]",
                JSON.stringify({ totalMs: +(performance.now() - started).toFixed(1), times: times.map((x) => +x.ms.toFixed(1)) }),
              )
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    { timeout: 30_000 },
  )
})
