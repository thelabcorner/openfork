import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { buildResult } from "../../src/quota/format"
import { createSingleFlight, resolveAdapter, type Adapter } from "../../src/quota/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("QuotaRegistry", () => {
  it.effect("coalesces concurrent same-key fetches into one execution", () =>
    Effect.gen(function* () {
      const singleFlight = createSingleFlight()
      const release = yield* Deferred.make<void>()
      const state = { executions: 0 }
      const task = Effect.gen(function* () {
        state.executions += 1
        yield* Deferred.await(release)
        return buildResult({ providerId: "probe", providerName: "Probe", ok: true, configured: true })
      })

      const first = yield* Effect.forkChild(singleFlight("openrouter", task))
      // Let the first fiber run until it suspends on the release deferred —
      // by then the pending entry is published.
      yield* Effect.yieldNow
      const second = yield* Effect.forkChild(singleFlight("openrouter", task))
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)

      const firstExit = yield* Fiber.await(first)
      const secondExit = yield* Fiber.await(second)
      expect(state.executions).toBe(1)
      expect(Exit.isSuccess(firstExit)).toBe(true)
      expect(Exit.isSuccess(secondExit)).toBe(true)
      if (Exit.isSuccess(firstExit) && Exit.isSuccess(secondExit)) {
        expect(secondExit.value).toEqual(firstExit.value)
      }

      // Completion removes the pending entry: a later call executes again.
      yield* singleFlight("openrouter", task)
      expect(state.executions).toBe(2)
    }))

  it.effect("different keys execute independently", () =>
    Effect.gen(function* () {
      const singleFlight = createSingleFlight()
      const releaseA = yield* Deferred.make<void>()
      const releaseB = yield* Deferred.make<void>()
      const state = { executions: 0 }

      const fiberA = yield* Effect.forkChild(
        Effect.gen(function* () {
          state.executions += 1
          yield* Deferred.await(releaseA)
          return buildResult({ providerId: "openrouter", providerName: "OpenRouter", ok: true, configured: true })
        }).pipe((task) => singleFlight("openrouter", task)),
      )
      yield* Effect.yieldNow
      const fiberB = yield* Effect.forkChild(
        Effect.gen(function* () {
          state.executions += 1
          yield* Deferred.await(releaseB)
          return buildResult({ providerId: "kimi-for-coding", providerName: "Kimi", ok: true, configured: true })
        }).pipe((task) => singleFlight("kimi-for-coding", task)),
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseB, undefined)
      yield* Deferred.succeed(releaseA, undefined)
      yield* Fiber.await(fiberA)
      yield* Fiber.await(fiberB)
      expect(state.executions).toBe(2)
    }))

  it.effect("collapses a defective task into an error result instead of failing", () =>
    Effect.gen(function* () {
      const singleFlight = createSingleFlight()
      const result = yield* singleFlight("broken", Effect.die(new Error("adapter defect")))
      expect(result.ok).toBe(false)
      expect(result.configured).toBe(true)
      expect(result.error).toBe("adapter defect")
    }))
})

describe("QuotaRegistry.resolveAdapter", () => {
  const adapters: readonly Adapter[] = [
    { id: "kimi-for-coding", name: "Kimi", aliases: ["kimi"], configured: () => Effect.succeed(true), fetch: () => Effect.die("unused") },
    { id: "opencode-go", name: "Go", aliases: ["opencode"], configured: () => Effect.succeed(false), fetch: () => Effect.die("unused") },
  ]

  test("resolves by id and alias with normalization", () => {
    expect(resolveAdapter(adapters, "kimi-for-coding")?.id).toBe("kimi-for-coding")
    expect(resolveAdapter(adapters, "kimi")?.id).toBe("kimi-for-coding")
    expect(resolveAdapter(adapters, " Kimi ")?.id).toBe("kimi-for-coding")
    expect(resolveAdapter(adapters, "opencode-go")?.id).toBe("opencode-go")
    expect(resolveAdapter(adapters, "nope")).toBeUndefined()
  })
})
