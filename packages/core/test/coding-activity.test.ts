import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(LayerNode.group([CodingActivity.node]))
const it = testEffect(layer)

const collect = (activity: CodingActivity.Interface, count: number) =>
  activity.stream().pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)

describe("CodingActivity", () => {
  it.effect("propagates recorded activity to subscribers without rewriting known fields", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      const input: CodingActivity.Activity = {
        entity: "/repo/src/index.ts",
        kind: "write",
        time: 1_700_000_000,
        aiLineChanges: 12,
        aiSession: "ses_alpha",
        project: "openfork",
        projectFolder: "/repo",
        projectRootCount: 2,
        branch: "main",
        language: "typescript",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" },
        source: "session",
        sourceRef: "call_01",
      }

      expect(yield* activity.record(input)).toBe(true)

      expect(Array.from(yield* Fiber.join(fiber))).toEqual([input])
    }),
  )

  it.live("defaults a finite time when the producer omits it", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(yield* activity.record({ entity: "/repo/src/a.ts", kind: "read", source: "core" })).toBe(true)

      const [received] = Array.from(yield* Fiber.join(fiber))
      expect(Number.isFinite(received!.time)).toBe(true)
      expect(received!.time).toBeGreaterThan(0)
    }),
  )

  it.effect("normalizes generic invariants without deriving project or language", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(
        yield* activity.record({
          entity: "/repo/src/b.ts",
          kind: "write",
          time: Number.NaN,
          aiLineChanges: -3.7,
          projectRootCount: -2,
          language: undefined,
          source: "ofxp",
        }),
      ).toBe(true)

      const [received] = Array.from(yield* Fiber.join(fiber))
      expect(Number.isFinite(received!.time)).toBe(true)
      expect(received!.aiLineChanges).toBe(-3)
      expect(received!.projectRootCount).toBe(0)
      expect(received!.project).toBeUndefined()
      expect(received!.branch).toBeUndefined()
      expect(received!.language).toBeUndefined()
    }),
  )

  it.effect("carries an observed project folder and never invents one", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(
        yield* activity.record({
          entity: "/repo/src/c.ts",
          kind: "write",
          source: "session",
          project: "openfork",
          projectFolder: "  /repo/packages/core  ",
        }),
      ).toBe(true)

      const [received] = Array.from(yield* Fiber.join(fiber))
      // A real directory is normalized, and the display name stays separate:
      // downstream consumers that need a folder and consumers that need a name
      // cannot be confused for one another.
      expect(received!.projectFolder).toBe("/repo/packages/core")
      expect(received!.project).toBe("openfork")
    }),
  )

  it.effect("drops a blank folder instead of forwarding an empty path", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(
        yield* activity.record({
          entity: "/repo/src/d.ts",
          kind: "read",
          source: "core",
          project: "openfork",
          projectFolder: "   ",
        }),
      ).toBe(true)

      const [received] = Array.from(yield* Fiber.join(fiber))
      // A blank value names no directory, so nothing is invented from the
      // project display name or a working directory.
      expect(received!.projectFolder).toBeUndefined()
      expect(received!.project).toBe("openfork")
    }),
  )

  it.effect("ignores a non-string project folder rather than coercing it", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(
        yield* activity.record({
          entity: "/repo/src/e.ts",
          kind: "read",
          source: "oxp",
          projectFolder: 42 as unknown as string,
        }),
      ).toBe(true)

      const [received] = Array.from(yield* Fiber.join(fiber))
      expect(received!.projectFolder).toBeUndefined()
    }),
  )

  it.effect("ignores empty or non-string entities fail-safe", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const fiber = yield* collect(activity, 1)
      yield* Effect.yieldNow

      expect(yield* activity.record({ entity: "", kind: "read", source: "http" })).toBe(false)
      expect(yield* activity.record({ entity: "   ", kind: "write", source: "oxp" })).toBe(false)
      expect(
        yield* activity.record({ entity: undefined as unknown as string, kind: "read", source: "core" }),
      ).toBe(false)
      expect(yield* activity.record({ entity: "/repo/valid.ts", kind: "read", source: "ofxp" })).toBe(true)

      const received = Array.from(yield* Fiber.join(fiber))
      expect(received).toHaveLength(1)
      expect(received[0]?.entity).toBe("/repo/valid.ts")
    }),
  )

  it.live("slides a bounded window past a stalled subscriber without blocking the producer", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const gate = yield* Deferred.make<void>()
      const stalled = yield* activity.stream().pipe(
        Stream.tap(() => Deferred.await(gate)),
        Stream.take(CodingActivity.SLIDING_CAPACITY),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      const burst = Effect.gen(function* () {
        for (const index of Array.from(
          { length: CodingActivity.SLIDING_CAPACITY * 2 + 1 },
          (_, offset) => offset,
        )) {
          expect(
            yield* activity.record({
              entity: `/repo/file-${index}.ts`,
              kind: "read",
              time: index,
              source: "session",
            }),
          ).toBe(true)
        }
      })
      expect(Exit.isSuccess(yield* burst.pipe(Effect.timeout("5 seconds"), Effect.exit))).toBe(true)

      yield* Deferred.succeed(gate, undefined)

      const received = Array.from(yield* Fiber.join(stalled))
      expect(received).toHaveLength(CodingActivity.SLIDING_CAPACITY)
      const indexes = received.map((entry) => Number(/file-(\d+)\.ts/.exec(entry.entity)?.[1]))
      expect(indexes.every((index) => index === 0 || index >= CodingActivity.SLIDING_CAPACITY + 1)).toBe(true)
      expect(indexes.at(-1)).toBeGreaterThanOrEqual(CodingActivity.SLIDING_CAPACITY + 1)
    }),
  )

  it.effect("fans out to every subscriber without coupling the producer", () =>
    Effect.gen(function* () {
      const activity = yield* CodingActivity.Service
      const first = yield* collect(activity, 2)
      const second = yield* collect(activity, 2)
      const third = yield* collect(activity, 2)
      yield* Effect.yieldNow

      expect(yield* activity.record({ entity: "/repo/a.ts", kind: "read", source: "session" })).toBe(true)
      expect(yield* activity.record({ entity: "/repo/b.ts", kind: "write", source: "session" })).toBe(true)

      for (const fiber of [first, second, third]) {
        expect(Array.from(yield* Fiber.join(fiber)).map((entry) => entry.entity)).toEqual([
          "/repo/a.ts",
          "/repo/b.ts",
        ])
      }
    }),
  )

  it.effect("emits through the canonical bus from outside any Service environment", () =>
    Effect.gen(function* () {
      const service = yield* CodingActivity.Service
      const fiber = yield* service.stream().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* CodingActivity.record({ entity: "/repo/top-level.ts", kind: "write", source: "core" })).toBe(true)

      expect(Array.from(yield* Fiber.join(fiber)).map((entry) => entry.entity)).toEqual(["/repo/top-level.ts"])
    }),
  )

  test("separately built Service layers share the single canonical bus", async () => {
    const build = () => AppNodeBuilder.build(LayerNode.group([CodingActivity.node]))
    const identityOf = (layer: ReturnType<typeof build>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* CodingActivity.Service
          return { record: service.record, stream: service.stream }
        }).pipe(Effect.provide(layer)),
      )

    const first = await identityOf(build())
    const second = await identityOf(build())
    expect(first.record).toBe(CodingActivity.record)
    expect(first.stream).toBe(CodingActivity.stream)
    expect(second.record).toBe(CodingActivity.record)
    expect(second.stream).toBe(CodingActivity.stream)

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* CodingActivity.Service
          const fiber = yield* service.stream().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.yieldNow
          expect(
            yield* CodingActivity.record({ entity: "/repo/layer-b.ts", kind: "write", source: "ofxp" }),
          ).toBe(true)
          return Array.from(yield* Fiber.join(fiber))
        }).pipe(Effect.provide(build())),
      ),
    )
    expect(observed.map((entry) => entry.entity)).toEqual(["/repo/layer-b.ts"])
  })

  test("stays a process-global semantic seam with no workspace runtime dependency", async () => {
    const source = await readFile(join(import.meta.dir, "../src/coding-activity.ts"), "utf8")
    for (const forbidden of [
      "Location",
      "InstanceState",
      "locationServices",
      "Snapshot",
      "WakaTime",
      "Database",
      "EventV2",
      "plugin",
      "Plugin",
      "server/routes",
      "protocol",
      "sdk",
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).toContain("makeGlobalNode")
    expect(source).toContain("@opencode/CodingActivity")
    expect(source).toContain("Layer.succeed")
    expect(source).not.toContain("addFinalizer")
    expect(source).not.toContain("PubSub.shutdown")
  })
})
