import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ProjectInventory } from "@opencode-ai/core/project-inventory"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// Seeds a project whose inventory domain deliberately includes the edge cases a
// watcher-maintained search list cannot represent:
//   - a dotfile tracked by Git (.env)
//   - a tracked file under a NESTED watcher-ambiguous folder
//     (packages/desktop/src/important.ts), which the native subscription still
//     delivers and the callback whitelist must keep observable
//   - an untracked, non-ignored file (untracked.txt)
//   - a gitignored file (ignored.txt) and a gitignored directory (node_modules/)
const seedProject = Effect.fn("InventoryTest.seedProject")(function* (project: string) {
  yield* Effect.promise(async () => {
    await fs.mkdir(project)
    await fs.mkdir(path.join(project, "src"))
    await fs.mkdir(path.join(project, "packages", "desktop", "src"), { recursive: true })
    await fs.mkdir(path.join(project, "node_modules"))
    await fs.writeFile(path.join(project, ".gitignore"), "ignored.txt\nnode_modules/\n")
    await fs.writeFile(path.join(project, "src", "index.ts"), "export const x = 1\n")
    await fs.writeFile(path.join(project, ".env"), "SECRET=1\n")
    await fs.writeFile(path.join(project, "packages", "desktop", "src", "important.ts"), "export const y = 2\n")
    await fs.writeFile(path.join(project, "ignored.txt"), "ignore me\n")
    await fs.writeFile(path.join(project, "node_modules", "dep.js"), "dep\n")
    await $`git init`.cwd(project).quiet()
    await $`git config core.fsmonitor false`.cwd(project).quiet()
    await $`git config commit.gpgsign false`.cwd(project).quiet()
    await $`git config user.email test@opencode.test`.cwd(project).quiet()
    await $`git config user.name Test`.cwd(project).quiet()
    await $`git add .`.cwd(project).quiet()
    await $`git commit -m initial`.cwd(project).quiet()
    await fs.writeFile(path.join(project, "untracked.txt"), "new\n")
  })
})

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({ entries: () => Effect.succeed([]) }),
)

const withInventory = <A, E, R>(
  body: (inventory: ProjectInventory.Interface, project: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const project = path.join(tmp.path, "project")
        yield* seedProject(project)
        const location = AppNodeBuilder.build(ProjectInventory.node, [
          [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
          [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
        ])
        return yield* Effect.gen(function* () {
          const inventory = yield* ProjectInventory.Service
          return yield* body(inventory, project)
        }).pipe(Effect.provide(location))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const withWatchedInventory = <A, E, R>(
  body: (inventory: ProjectInventory.Interface, project: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const project = path.join(tmp.path, "project")
        yield* seedProject(project)
        const graph = AppNodeBuilder.build(LayerNode.group([Watcher.node, ProjectInventory.node]), [
          [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
          [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
          [Config.node, configLayer],
        ]).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
                OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
              }),
            ),
          ),
        )
        return yield* Effect.gen(function* () {
          const inventory = yield* ProjectInventory.Service
          return yield* body(inventory, project)
        }).pipe(Effect.provide(graph))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const poll = <A>(check: () => Effect.Effect<A>, ok: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let index = 0; index < 120; index++) {
      if (ok(yield* check())) return true
      yield* Effect.sleep("50 millis")
    }
    return false
  })

describe("ProjectInventory", () => {
  it.live(
    "seeds the exact Snapshot domain with Git semantics",
    () =>
      withInventory((inventory) =>
        Effect.gen(function* () {
          const files = yield* inventory.files()

          expect(files).toContain("src/index.ts")
          expect(files).toContain(".gitignore")
          // Dotfiles and tracked files under nested watcher-ambiguous folders
          // survive: the ambiguous segment is whitelisted because it provably
          // contains tracked files, so the watcher still observes it.
          expect(files).toContain(".env")
          expect(files).toContain("packages/desktop/src/important.ts")
          expect(files).toContain("untracked.txt")

          // Git-ignore semantics are preserved.
          expect(files).not.toContain("ignored.txt")
          expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false)

          const untracked = yield* inventory.untracked()
          expect(untracked).toContain("untracked.txt")
          expect(untracked).not.toContain("src/index.ts")
          expect(untracked).not.toContain("packages/desktop/src/important.ts")

          const diagnostics = yield* inventory.diagnostics()
          expect(diagnostics.coverage).toBe("git")
          expect(diagnostics.tracked).toBeGreaterThanOrEqual(4)
          expect(diagnostics.untracked).toBe(1)
          // The nested ambiguous folder is tracked-covered, so the domain has
          // no watcher-invisible gap. `complete` is still false here because no
          // native watcher owns the root in this environment.
          expect(diagnostics.gaps).toBe(false)
          expect(diagnostics.complete).toBe(false)
        }),
      ),
    { timeout: 30_000 },
  )

  it.live(
    "shares one authoritative rebuild across concurrent readers",
    () =>
      withInventory((inventory) =>
        Effect.gen(function* () {
          yield* inventory.files()
          const seeded = yield* inventory.diagnostics()

          // Repeated reads are served from the completed inventory.
          yield* inventory.files()
          const repeated = yield* inventory.diagnostics()
          expect(repeated.rebuilds).toBe(seeded.rebuilds)
          expect(repeated.revision).toBe(seeded.revision)

          yield* inventory.refresh()
          const refreshed = yield* inventory.diagnostics()
          expect(refreshed.rebuilds - seeded.rebuilds).toBe(1)

          // One invalidation followed by six concurrent readers is one rebuild.
          yield* inventory.invalidate("test:fan-in")
          const readers = yield* Effect.all(
            Array.from({ length: 6 }, () => inventory.files()),
            { concurrency: "unbounded" },
          )
          const final = yield* inventory.diagnostics()
          expect(final.rebuilds - refreshed.rebuilds).toBe(1)
          for (const files of readers) expect(files.length).toBe(final.tracked + final.untracked)
        }),
      ),
    { timeout: 30_000 },
  )
})

const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

describeWatcher("ProjectInventory native watcher coverage", () => {
  it.live(
    "proves coverage and observes files under a nested ambiguous tracked folder",
    () =>
      withWatchedInventory((inventory, project) =>
        Effect.gen(function* () {
          // The root subscription is forked at layer build; wait for runtime
          // ownership instead of guessing with a sleep.
          expect(yield* poll(() => Effect.sync(() => Watcher.hasActiveRoot(project)), (owned) => owned)).toBe(true)

          const diagnostics = yield* inventory.diagnostics()
          expect(diagnostics.watcherOwnedRoot).toBe(true)
          expect(diagnostics.gaps).toBe(false)
          expect(diagnostics.complete).toBe(true)

          // A NEW untracked file inside the nested folder must be observed. The
          // old segment-based callback guard dropped exactly these events.
          yield* Effect.promise(() =>
            fs.mkdir(path.join(project, "packages", "desktop", "extra"), { recursive: true }),
          )
          yield* Effect.promise(() =>
            fs.writeFile(path.join(project, "packages", "desktop", "extra", "new.ts"), "export const z = 3\n"),
          )
          expect(
            yield* poll(() => inventory.files(), (files) => files.includes("packages/desktop/extra/new.ts")),
          ).toBe(true)
        }),
      ),
    { timeout: 30_000 },
  )
})
