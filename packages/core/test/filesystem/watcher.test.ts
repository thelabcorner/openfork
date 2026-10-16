import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

test("watcher deduplication preserves create-delete-create terminal state", () => {
  const updates = ["create", "create", "delete", "create"].map((type) => ({ path: "a", type }))
  expect(Watcher.dedupeUpdates(updates).map((event) => event.type)).toEqual(["create", "delete", "create"])
})

test("filesystem-root watcher guard recognizes only the host root", () => {
  const root = path.parse(process.cwd()).root
  expect(Watcher.isFilesystemRoot(root)).toBe(true)
  expect(Watcher.isFilesystemRoot(process.cwd())).toBe(path.resolve(process.cwd()) === root)
})

test("git control allowlist excludes transient entries created after startup", () => {
  for (const name of ["HEAD", "refs/heads/main", "refs\\heads\\new", "packed-refs"]) {
    expect(Watcher.isGitControlPath(name)).toBe(true)
  }
  for (const name of ["HEAD.lock", "index.lock", "MERGE_HEAD", "ORIG_HEAD", "COMMIT_EDITMSG", "objects/a"]) {
    expect(Watcher.isGitControlPath(name)).toBe(false)
  }
})

test("Git ignored watcher projection is bounded and prefix-safe", () => {
  expect(Ignore.boundedProjection(["generated/", "cache"])).toEqual(["generated", "cache"])
  expect(Ignore.projectedIgnored("generated/deep/file.ts", ["generated"])).toBe(true)
  expect(Ignore.projectedIgnored("generated-other/file.ts", ["generated"])).toBe(false)
  expect(Ignore.projectedIgnored("anything/nested/file.ts", ["**"])).toBe(true)
  const oversized = Ignore.boundedProjection(
    Array.from({ length: Ignore.MAX_GIT_IGNORED_PATHS + 1 }, (_, i) => `ignored-${i}`),
  )
  expect(oversized).toHaveLength(Ignore.MAX_GIT_IGNORED_PATHS)
  expect(oversized[0]).toBe("ignored-0")
})

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))

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
  }),
)

function provide(directory: string, vcs?: Location.Interface["vcs"]) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  return Effect.provide(
    AppNodeBuilder.build(Watcher.node, [
      [Config.node, configLayer],
      [Location.node, locationLayer],
    ]).pipe(Layer.provide(flagsLayer)),
  )
}

function withTmp<A, E, R>(
  f: (directory: string, vcs?: Location.Interface["vcs"]) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; init?: (directory: string) => Promise<void>; watch?: (directory: string) => string },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      if (!options?.git) return { tmp, vcs: undefined }
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      await options.init?.(tmp.path)
      return { tmp, vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) } }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap(({ tmp, vcs }) => {
      const watched = options?.watch?.(tmp.path) ?? tmp.path
      return f(watched, vcs).pipe(provide(watched, vcs))
    }),
  )
}

function wait(check: (event: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* events.subscribe(Watcher.Event.Updated).pipe(
      Stream.runForEach((event) => {
        if (!check(event.data)) return Effect.void
        return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
      }),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

function maybeNextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout: Duration.Input = "5 seconds",
) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) => trigger.pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeoutOption(timeout)),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function nextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout: Duration.Input = "5 seconds",
) {
  return Effect.gen(function* () {
    const result = yield* maybeNextUpdate(check, trigger, timeout)
    if (Option.isSome(result)) return result.value
    return yield* Effect.fail(new Error("timed out waiting for file watcher update"))
  })
}

function eventuallyUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: () => Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* maybeNextUpdate(check, trigger(), "250 millis")
      if (Option.isSome(result)) return result.value
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for file watcher readiness")),
    }),
  )
}

function noUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>, timeout = 500) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) =>
      trigger.pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOption(`${timeout} millis`),
        Effect.tap((result) => Effect.sync(() => expect(result).toEqual(Option.none()))),
      ),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* eventuallyUpdate(
      (event) => event.file === file,
      () => fs.writeFileString(file, `ready-${Math.random()}`),
    ).pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)), Effect.asVoid)
  })
}

describe("dedupeUpdates", () => {
  test("collapses exact-duplicate path+type notifications", () => {
    expect(
      Watcher.dedupeUpdates([
        { path: "/a.txt", type: "update" },
        { path: "/a.txt", type: "update" },
        { path: "/b.txt", type: "create" },
        { path: "/a.txt", type: "update" },
      ]),
    ).toEqual([
      { path: "/a.txt", type: "update" },
      { path: "/b.txt", type: "create" },
    ])
  })

  test("keeps different types for the same path", () => {
    expect(
      Watcher.dedupeUpdates([
        { path: "/a.txt", type: "create" },
        { path: "/a.txt", type: "update" },
        { path: "/a.txt", type: "delete" },
      ]),
    ).toEqual([
      { path: "/a.txt", type: "create" },
      { path: "/a.txt", type: "update" },
      { path: "/a.txt", type: "delete" },
    ])
  })

  test("passes through an empty batch", () => {
    expect(Watcher.dedupeUpdates([])).toEqual([])
  })
})

describeWatcher("Watcher", () => {
  it.live("does not register a native subscription for the filesystem root", () =>
    withTmp(
      (directory) => Effect.sync(() => expect(Watcher.activeRootCount(directory)).toBe(0)),
      { watch: () => path.parse(process.cwd()).root },
    ),
  )

  it.live("prunes a large Git-ignored tree and refreshes when rules unignore it", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const ignored = path.join(directory, "large")
          const hidden = path.join(ignored, "generated", "new.txt")
          const rules = path.join(directory, ".gitignore")
          yield* ready(directory)
          yield* noUpdate(
            (event) => event.file === hidden,
            fs.writeFileString(hidden, "hidden"),
          )
          expect(
            yield* nextUpdate(
              (event) => event.file.startsWith(ignored) && event.event === "add",
              fs.writeFileString(rules, ""),
              "15 seconds",
            ),
          ).toEqual({ file: ignored, event: "add" })
          expect(
            yield* nextUpdate(
              (event) => event.file === hidden && event.event === "change",
              fs.writeFileString(hidden, "visible"),
              "15 seconds",
            ),
          ).toEqual({ file: hidden, event: "change" })
        }),
      {
        git: true,
        init: async (directory) => {
          await fs.writeFile(path.join(directory, ".gitignore"), "large/\n")
          await fs.mkdir(path.join(directory, "large", "generated"), { recursive: true })
          for (let i = 0; i < 256; i++) {
            await fs.writeFile(path.join(directory, "large", "generated", `seed-${i}.txt`), "x")
          }
          await $`git add .gitignore`.cwd(directory).quiet()
          await $`git commit -m ignored-tree`.cwd(directory).quiet()
        },
      },
    ),
    20_000,
  )

  it.live("scopes Git ignore projection to a nested workspace root", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const hidden = path.join(directory, "generated", "new.txt")
          const visible = path.join(directory, "keep.txt")
          yield* ready(directory)
          yield* noUpdate((event) => event.file === hidden, fs.writeFileString(hidden, "hidden"))
          expect(
            yield* nextUpdate(
              (event) => event.file === visible && event.event === "change",
              fs.writeFileString(visible, "visible update"),
            ),
          ).toEqual({ file: visible, event: "change" })
        }),
      {
        git: true,
        watch: (root) => path.join(root, "large"),
        init: async (root) => {
          await fs.writeFile(path.join(root, ".gitignore"), "large/generated/\n")
          await fs.mkdir(path.join(root, "large", "generated"), { recursive: true })
          await fs.writeFile(path.join(root, "large", "keep.txt"), "tracked\n")
          await $`git add .gitignore large/keep.txt`.cwd(root).quiet()
          await $`git commit -m nested-watcher`.cwd(root).quiet()
        },
      },
    ),
  )

  it.live("publishes root create, update, and delete events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const file = path.join(directory, "watch.txt")
          yield* ready(directory)
          for (const item of [
            { event: "add" as const, trigger: fs.writeFileString(file, "a") },
            { event: "change" as const, trigger: fs.writeFileString(file, "b") },
            { event: "unlink" as const, trigger: fs.remove(file) },
          ]) {
            expect(
              yield* nextUpdate((event) => event.file === file && event.event === item.event, item.trigger),
            ).toEqual({
              file,
              event: item.event,
            })
          }
        }),
      { git: true },
    ),
  )

  it.live("watches non-git roots", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "plain.txt")
        yield* ready(directory)
        expect(
          yield* nextUpdate(
            (event) => event.file === file && event.event === "add",
            fs.writeFileString(file, "plain"),
          ),
        ).toEqual({
          file,
          event: "add",
        })
      }),
    ),
  )

  it.live("cleanup stops publishing events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* ready(tmp.path).pipe(
        provide(tmp.path, { type: "git", store: AbsolutePath.make(path.join(tmp.path, ".git")) }),
        Effect.scoped,
      )
      const file = path.join(tmp.path, "after-dispose.txt")
      yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "gone")).pipe(
        Effect.provideService(EventV2.Service, events),
      )
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))),
  )

  it.live("ignores .git/index changes", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const index = path.join(directory, ".git", "index")
          yield* ready(directory)
          yield* noUpdate(
            (event) => event.file === index,
            fs
              .writeFileString(path.join(directory, "tracked.txt"), "a")
              .pipe(Effect.andThen(Effect.promise(() => $`git add .`.cwd(directory).quiet())), Effect.asVoid),
          )
        }),
      { git: true },
    ),
  )

  it.live("publishes .git/HEAD events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const head = path.join(directory, ".git", "HEAD")
          const branch = `watch-${Math.random().toString(36).slice(2)}`
          yield* ready(directory)
          yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
          expect(
            yield* nextUpdate((event) => event.file === head, fs.writeFileString(head, `ref: refs/heads/${branch}\n`)),
          ).toMatchObject({ file: head })
        }),
      { git: true },
    ),
  )

  const describeSymlink = process.platform !== "win32" ? describe : describe.skip
  describeSymlink("symlinked .git", () => {
    it.live("publishes .git/HEAD events through a symlinked .git directory", () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const afs = yield* FSUtil.Service
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(actual, { recursive: true, force: true })))
            yield* ready(directory)
            const head = path.join(directory, ".git", "HEAD")
            const branch = `watch-${Math.random().toString(36).slice(2)}`
            yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
            expect(
              yield* nextUpdate(
                (event) => event.file === path.join(actual, "HEAD"),
                afs.writeFileString(head, `ref: refs/heads/${branch}\n`),
              ),
            ).toEqual({ file: path.join(actual, "HEAD"), event: "change" })
          }),
        {
          git: true,
          init: async (directory) => {
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            await fs.rename(path.join(directory, ".git"), actual)
            await fs.symlink(actual, path.join(directory, ".git"))
          },
        },
      ),
    )
  })
})
