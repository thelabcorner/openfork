import { describe, expect } from "bun:test"
import {
  MAX_TRACKED_OPERATIONS,
  OPERATION_TTL_MS,
  RevisionProgress,
  clampPercent,
  normalizeOperationID,
} from "@opencode-ai/core/revision-progress"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(RevisionProgress.layer)

describe("RevisionProgress", () => {
  it.effect("clamps self-reported percentages and ignores unusable ids/values", () =>
    Effect.gen(function* () {
      const progress = yield* RevisionProgress.Service

      expect(clampPercent(150)).toBe(100)
      expect(clampPercent(-5)).toBe(0)
      expect(clampPercent(41.6)).toBe(42)
      expect(clampPercent(Number.NaN)).toBeUndefined()
      expect(clampPercent(Number.POSITIVE_INFINITY)).toBeUndefined()
      expect(clampPercent("50")).toBeUndefined()
      expect(normalizeOperationID(" op-1 ")).toBe("op-1")
      expect(normalizeOperationID("bad id")).toBeUndefined()
      expect(normalizeOperationID("")).toBeUndefined()
      expect(normalizeOperationID("x".repeat(129))).toBeUndefined()
      expect(normalizeOperationID(undefined)).toBeUndefined()

      expect(yield* progress.report({ operationID: "op", percent: 10 })).toMatchObject({ percent: 10 })
      expect(yield* progress.report({ operationID: "op", percent: Number.NaN, phase: "ignored" })).toBeUndefined()
      expect(yield* progress.report({ operationID: "", percent: 90 })).toBeUndefined()
      expect((yield* progress.latest("op"))?.percent).toBe(10)
      expect((yield* progress.latest("op"))?.phase).toBeUndefined()
    }),
  )

  it.effect("keeps the monotonic maximum with the latest bounded phase/note", () =>
    Effect.gen(function* () {
      const progress = yield* RevisionProgress.Service

      yield* progress.report({
        operationID: "op",
        percent: 60,
        phase: "reading",
        note: "scanning the parser",
        now: 1,
      })
      const regressed = yield* progress.report({
        operationID: "op",
        percent: 20,
        phase: "rewriting",
        note: `  ${"n".repeat(400)}  `,
        now: 2,
      })

      expect(regressed?.percent).toBe(60)
      expect(regressed?.phase).toBe("rewriting")
      expect(regressed?.note).toHaveLength(160)
      expect((yield* progress.latest("op", 3))?.updatedAt).toBe(2)
    }),
  )

  it.effect("expires idle operations and bounds concurrency by oldest update", () =>
    Effect.gen(function* () {
      const progress = yield* RevisionProgress.Service

      yield* progress.report({ operationID: "fresh", percent: 5, now: 0 })
      expect((yield* progress.latest("fresh", OPERATION_TTL_MS - 1))?.percent).toBe(5)
      expect(yield* progress.latest("fresh", OPERATION_TTL_MS)).toBeUndefined()

      for (let index = 0; index <= MAX_TRACKED_OPERATIONS; index++) {
        yield* progress.report({ operationID: `op-${index}`, percent: index, now: 10_000 + index })
      }
      expect(yield* progress.latest("op-0", 20_000)).toBeUndefined()
      expect((yield* progress.latest(`op-${MAX_TRACKED_OPERATIONS}`, 20_000))?.percent).toBe(MAX_TRACKED_OPERATIONS)
    }),
  )

  it.effect("clears one operation without touching concurrent operations", () =>
    Effect.gen(function* () {
      const progress = yield* RevisionProgress.Service

      yield* progress.report({ operationID: "a", percent: 10, now: 1 })
      yield* progress.report({ operationID: "b", percent: 20, now: 1 })
      yield* progress.clear("a")

      expect(yield* progress.latest("a", 2)).toBeUndefined()
      expect((yield* progress.latest("b", 2))?.percent).toBe(20)
      yield* progress.clear("not-a-real-op")
    }),
  )
})
