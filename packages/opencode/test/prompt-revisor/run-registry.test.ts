import { describe, expect, setSystemTime, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { PromptRevisorRuns } from "@/prompt-revisor/run-registry"
import { pollWithTimeout, testEffect } from "../lib/effect"

const locator = (key: string): RevisionDraft.Locator => ({ kind: "prompt", key })

const revision = (prompt: string): PromptRevisor.Result => ({
  type: "revision",
  prompt,
  references: [],
  tools: [],
  rounds: 1,
})

const failure = (message: string) => new PromptRevisor.UnavailableError({ message })

const uniqueKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

describe("PromptRevisorRuns", () => {
  test("attaches a second request with the same fingerprint to one shared run", async () => {
    const key = uniqueKey("attach")
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const input = { locator: locator(key), sourceFingerprint: "same" }
        const first = yield* PromptRevisorRuns.begin(input)
        const second = yield* PromptRevisorRuns.begin(input)
        yield* PromptRevisorRuns.cancel({ locator: locator(key) })
        return { first, second }
      }),
    )
    expect(outcome.first.created).toBe(true)
    expect(outcome.second.created).toBe(false)
    expect(outcome.second.handle.deferred).toBe(outcome.first.handle.deferred)
  })

  test("a changed fingerprint supersedes the in-flight run and fails only its waiter", async () => {
    const key = uniqueKey("supersede")
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* PromptRevisorRuns.begin({ locator: locator(key), sourceFingerprint: "v1" })
        const second = yield* PromptRevisorRuns.begin({ locator: locator(key), sourceFingerprint: "v2" })
        const exit = yield* Deferred.await(first.handle.deferred).pipe(Effect.exit)
        const status = yield* PromptRevisorRuns.status(locator(key))
        yield* PromptRevisorRuns.cancel({ locator: locator(key) })
        return { second, exit, status }
      }),
    )
    expect(outcome.second.created).toBe(true)
    expect(Exit.isFailure(outcome.exit)).toBe(true)
    const error = outcome.exit._tag === "Failure" ? Cause.squash(outcome.exit.cause) : undefined
    expect(error).toBeInstanceOf(PromptRevisor.UnavailableError)
    expect((error as PromptRevisor.UnavailableError).message).toContain("superseded")
    expect(outcome.status).toMatchObject({ state: "running", sourceFingerprint: "v2" })
  })

  test("cancel is first-class, idempotent, and refuses a mismatched correlation id", async () => {
    const key = uniqueKey("cancel")
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* PromptRevisorRuns.begin({
          locator: locator(key),
          sourceFingerprint: "fp",
          operationID: "op-owner",
        })
        const mismatched = yield* PromptRevisorRuns.cancel({ locator: locator(key), operationID: "op-other" })
        const runningAfterMismatch = yield* PromptRevisorRuns.status(locator(key))
        const cancelled = yield* PromptRevisorRuns.cancel({ locator: locator(key), operationID: "op-owner" })
        const result = yield* Deferred.await(run.handle.deferred)
        const statusAfter = yield* PromptRevisorRuns.status(locator(key))
        const again = yield* PromptRevisorRuns.cancel({ locator: locator(key) })
        return { run, mismatched, runningAfterMismatch, cancelled, result, statusAfter, again }
      }),
    )
    expect(outcome.run.created).toBe(true)
    expect(outcome.mismatched).toBe(false)
    expect(outcome.runningAfterMismatch?.state).toBe("running")
    expect(outcome.cancelled).toBe(true)
    expect(outcome.result).toEqual({ type: "cancelled", tools: [], rounds: 0 })
    expect(outcome.statusAfter).toBeUndefined()
    expect(outcome.again).toBe(false)
  })

  test("cancel interrupts the detached fiber and resolves the waiter as cancelled", async () => {
    const key = uniqueKey("cancel-fiber")
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const effect = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        const waiter = yield* Effect.forkDetach(
          PromptRevisorRuns.runDetached({ locator: locator(key), sourceFingerprint: "fp" }, effect),
        )
        yield* Deferred.await(started)
        const cancelled = yield* PromptRevisorRuns.cancel({ locator: locator(key) })
        const waiterResult = yield* Fiber.join(waiter)
        yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
        return { cancelled, waiterResult }
      }),
    )
    expect(outcome.cancelled).toBe(true)
    expect(outcome.waiterResult).toEqual({ type: "cancelled", tools: [], rounds: 0 })
  })

  test("without a locator the run keeps legacy request-scoped semantics", async () => {
    const result = await Effect.runPromise(
      PromptRevisorRuns.runDetached({}, Effect.succeed(revision("inline"))),
    )
    expect(result).toMatchObject({ type: "revision", prompt: "inline" })
  })

  test("interrupting the waiter does not interrupt the detached run", async () => {
    const key = uniqueKey("abort")
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const committed = yield* Deferred.make<string>()
        const effect = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(gate)
          yield* Deferred.succeed(committed, "done")
          return revision("survived-client-abort")
        })
        const waiter = yield* Effect.forkDetach(
          PromptRevisorRuns.runDetached({ locator: locator(key), sourceFingerprint: "fp" }, effect),
        )
        yield* Deferred.await(started)
        const before = yield* PromptRevisorRuns.status(locator(key))
        // A tab switch aborts the HTTP request fiber; only the waiter dies.
        yield* Fiber.interrupt(waiter)
        const after = yield* PromptRevisorRuns.status(locator(key))
        yield* Deferred.succeed(gate, undefined)
        const result = yield* pollWithTimeout(
          Deferred.await(committed),
          "detached run never completed after waiter abort",
          "2 seconds",
        )
        const settled = yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = yield* PromptRevisorRuns.status(locator(key))
            return status === undefined ? (true as const) : undefined
          }),
          "detached run never settled after waiter abort",
          "2 seconds",
        )
        return { before, after, result, settled }
      }),
    )
    expect(outcome.before?.state).toBe("running")
    expect(outcome.after?.state).toBe("running")
    expect(outcome.result).toBe("done")
    expect(outcome.settled).toBe(true)
  })

  test("retains a failure with a bounded TTL and clears it on the next success", async () => {
    const ttlKey = uniqueKey("ttl")
    const clearKey = uniqueKey("clear")
    const realNow = Date.now()
    try {
      setSystemTime(realNow)
      const retained = await Effect.runPromise(
        Effect.gen(function* () {
          const input = { locator: locator(ttlKey), sourceFingerprint: "fp" }
          const exit = yield* PromptRevisorRuns.runDetached(input, Effect.fail(failure("provider exploded"))).pipe(
            Effect.exit,
          )
          const status = yield* PromptRevisorRuns.status(locator(ttlKey))
          const beforeExpiry = yield* PromptRevisorRuns.status(locator(ttlKey))
          return { exit, status, beforeExpiry }
        }),
      )
      expect(Exit.isFailure(retained.exit)).toBe(true)
      expect(retained.status).toMatchObject({ state: "failed", message: "provider exploded" })

      setSystemTime(realNow + PromptRevisorRuns.FAILURE_TTL_MS)
      const expired = await Effect.runPromise(PromptRevisorRuns.status(locator(ttlKey)))
      expect(expired).toBeUndefined()

      // A later success for the same target must not be shadowed by a stale
      // failure record.
      const cleared = await Effect.runPromise(
        Effect.gen(function* () {
          yield* PromptRevisorRuns.runDetached(
            { locator: locator(clearKey), sourceFingerprint: "fp" },
            Effect.fail(failure("first attempt failed")),
          ).pipe(Effect.exit)
          const failed = yield* PromptRevisorRuns.status(locator(clearKey))
          const result = yield* PromptRevisorRuns.runDetached(
            { locator: locator(clearKey), sourceFingerprint: "fp" },
            Effect.succeed(revision("second attempt")),
          )
          const status = yield* PromptRevisorRuns.status(locator(clearKey))
          return { failed, result, status }
        }),
      )
      expect(cleared.failed?.state).toBe("failed")
      expect(cleared.result).toMatchObject({ prompt: "second attempt" })
      expect(cleared.status).toBeUndefined()
    } finally {
      setSystemTime()
    }
  })

  test("bounds retained failures by the oldest entry", async () => {
    const keys = Array.from({ length: PromptRevisorRuns.MAX_RECORDED_FAILURES + 1 }, () => uniqueKey("lru"))
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const key of keys) {
          yield* PromptRevisorRuns.runDetached(
            { locator: locator(key), sourceFingerprint: "fp" },
            Effect.fail(failure("boom")),
          ).pipe(Effect.exit)
        }
      }),
    )
    const oldest = await Effect.runPromise(PromptRevisorRuns.status(locator(keys[0]!)))
    const newest = await Effect.runPromise(PromptRevisorRuns.status(locator(keys.at(-1)!)))
    expect(oldest).toBeUndefined()
    expect(newest?.state).toBe("failed")
  })
})

const draftLayer = AppNodeBuilder.build(LayerNode.group([RevisionDraft.node, Database.node]))
const it = testEffect(draftLayer)

describe("PromptRevisorRuns durable handoff", () => {
  it.live("a client-aborted revise still commits and stays recoverable", () =>
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const key = uniqueKey("commit")
      const target = { kind: "prompt" as const, key, sourceFingerprint: "fp-commit" }
      const gate = yield* Deferred.make<void>()
      const claimed = yield* Deferred.make<void>()
      const effect = Effect.gen(function* () {
        const claimID = yield* drafts.claim({ target })
        yield* Deferred.succeed(claimed, undefined)
        yield* Deferred.await(gate)
        const artifact = yield* drafts.put({
          claimID,
          directory: "/tmp/test-workspace",
          target,
          purpose: "prompt",
          prompt: "revised while the composer was away",
          references: [],
        })
        return revision(artifact?.prompt ?? "")
      })

      const waiter = yield* Effect.forkDetach(
        PromptRevisorRuns.runDetached({ locator: { kind: "prompt", key }, sourceFingerprint: target.sourceFingerprint }, effect),
      )
      yield* Deferred.await(claimed)
      expect((yield* PromptRevisorRuns.status({ kind: "prompt", key }))?.state).toBe("running")

      // The composer unmounts: its request fiber is interrupted while the
      // provider work is still running.
      yield* Fiber.interrupt(waiter)
      expect((yield* PromptRevisorRuns.status({ kind: "prompt", key }))?.state).toBe("running")

      yield* Deferred.succeed(gate, undefined)
      const artifact = yield* pollWithTimeout(
        drafts.recover({ kind: "prompt", key }),
        "client-aborted revision never committed to the draft mailbox",
      )
      expect(artifact).toMatchObject({
        key,
        sourceFingerprint: "fp-commit",
        prompt: "revised while the composer was away",
      })
      expect(yield* PromptRevisorRuns.status({ kind: "prompt", key })).toBeUndefined()
    }),
  )
})
