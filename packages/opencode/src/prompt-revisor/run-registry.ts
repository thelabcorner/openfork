import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { RevisionProgress } from "@opencode-ai/core/revision-progress"

/**
 * Connection-independent registry for in-flight Prompt Revisor runs.
 *
 * The revise HTTP request used to OWN the run: when a composer navigated away
 * (tab switch) its cleanup aborted the fetch, `NodeHttpServer` interrupted the
 * request fiber with `ClientAbort`, and the whole revision died with it —
 * before `RevisionDraft.put` could ever run, so the result was unrecoverable.
 *
 * `runDetached` now forks the run into the global fiber scope and lets the
 * request merely AWAIT a shared `Deferred`. Abandoning the request (tab switch,
 * reload, renderer crash) therefore abandons only the waiter:
 *
 * - success commits the artifact through the existing `RevisionDraft` mailbox
 *   (the commit itself is already `Effect.uninterruptible` in Core) and the
 *   next composer mount recovers it;
 * - failure is retained here for a bounded TTL so a returning client can still
 *   surface it instead of failing silently;
 * - explicit cancellation is a first-class operation (`cancel`) because a raw
 *   client abort no longer stops the run;
 * - a second request for the same target attaches to the in-flight run when
 *   the source fingerprint matches (no duplicate resubmission) and supersedes
 *   it when the draft changed (mirroring the `RevisionDraft` claim semantics).
 *
 * Keys mirror the RevisionDraft locator (`kind` + `key`, process-unique for
 * every product UI target) so status/cancel/recover all address the same
 * identity without a workspace Instance.
 */

export const FAILURE_TTL_MS = 10 * 60_000
export const MAX_RECORDED_FAILURES = 64

export type InterruptReason = "cancel" | "supersede"

export interface RunInput {
  readonly locator: RevisionDraft.Locator
  readonly sourceFingerprint: string
  /** Client-owned correlation id; only well-formed ids are retained (progress parity). */
  readonly operationID?: string
}

/** Optional detach request; absent `locator` keeps legacy request-scoped semantics. */
export type DetachInput = Partial<RunInput>

interface RunEntry {
  readonly key: string
  readonly sourceFingerprint: string
  readonly operationID: string | undefined
  readonly startedAt: number
  readonly deferred: Deferred.Deferred<PromptRevisor.Result, PromptRevisor.UnavailableError>
  fiber: Fiber.Fiber<PromptRevisor.Result, PromptRevisor.UnavailableError> | undefined
  interrupt: InterruptReason | undefined
}

export interface RunHandle {
  readonly deferred: Deferred.Deferred<PromptRevisor.Result, PromptRevisor.UnavailableError>
}

export interface DetachedRun {
  /** Await this for the outcome of the run this request participates in. */
  readonly handle: RunHandle
  /** False when an identical in-flight run already existed; no new fiber is forked. */
  readonly created: boolean
  readonly bindFiber: (
    fiber: Fiber.Fiber<PromptRevisor.Result, PromptRevisor.UnavailableError>,
  ) => Effect.Effect<void>
  readonly finish: (exit: Exit.Exit<PromptRevisor.Result, PromptRevisor.UnavailableError>) => Effect.Effect<void>
}

export type RevisionRunStatus =
  | {
      readonly state: "running"
      readonly sourceFingerprint: string
      readonly operationID?: string
      readonly startedAt: number
    }
  | {
      readonly state: "failed"
      readonly sourceFingerprint: string
      readonly message: string
      readonly at: number
    }

const runs = new Map<string, RunEntry>()
const failures = new Map<string, { readonly sourceFingerprint: string; readonly message: string; readonly at: number }>()

const locatorKey = (locator: RevisionDraft.Locator) => `${locator.kind}\0${locator.key}`

const supersededError = () =>
  new PromptRevisor.UnavailableError({ message: "Revision was superseded by a newer request before it could be committed" })

const evictFailures = (now: number) => {
  for (const [key, failure] of failures) {
    if (now - failure.at >= FAILURE_TTL_MS) failures.delete(key)
  }
  while (failures.size > MAX_RECORDED_FAILURES) {
    const oldest = failures.keys().next()
    if (oldest.done) break
    failures.delete(oldest.value)
  }
}

const recordFailure = (key: string, entry: RunEntry, message: string) => {
  const now = Date.now()
  evictFailures(now)
  failures.set(key, { sourceFingerprint: entry.sourceFingerprint, message, at: now })
}

/** Interrupting an entry already completes its Deferred, so this is idempotent. */
const requestInterrupt = Effect.fn("PromptRevisorRuns.requestInterrupt")(function* (
  entry: RunEntry,
  reason: InterruptReason,
) {
  entry.interrupt ??= reason
  if (runs.get(entry.key) === entry) runs.delete(entry.key)
  if (reason === "cancel") {
    yield* Deferred.succeed(entry.deferred, { type: "cancelled" as const, tools: [] as readonly string[], rounds: 0 })
  } else {
    yield* Deferred.fail(entry.deferred, supersededError())
  }
  const fiber = entry.fiber
  if (fiber) yield* Effect.forkDetach(Fiber.interrupt(fiber))
})

/**
 * Join or create the detached run for one RevisionDraft locator.
 *
 * Same fingerprint → attach to the in-flight run (both requests await one
 * Deferred; the provider work happens exactly once). Different fingerprint →
 * the older run is superseded, matching the `RevisionDraft` claim upsert where
 * the newest generation is the only one allowed to become durable.
 */
export const begin = Effect.fn("PromptRevisorRuns.begin")(function* (input: RunInput) {
  const key = locatorKey(input.locator)
  evictFailures(Date.now())
  const existing = runs.get(key)
  if (existing && existing.sourceFingerprint === input.sourceFingerprint) {
    return {
      handle: { deferred: existing.deferred },
      created: false,
      bindFiber: () => Effect.void,
      finish: () => Effect.void,
    }
  }
  if (existing) yield* requestInterrupt(existing, "supersede")
  const deferred = yield* Deferred.make<PromptRevisor.Result, PromptRevisor.UnavailableError>()
  const entry: RunEntry = {
    key,
    sourceFingerprint: input.sourceFingerprint,
    operationID: RevisionProgress.normalizeOperationID(input.operationID),
    startedAt: Date.now(),
    deferred,
    fiber: undefined,
    interrupt: undefined,
  }
  runs.set(key, entry)
  failures.delete(key)
  return {
    handle: { deferred: entry.deferred },
    created: true,
    bindFiber: (fiber: Fiber.Fiber<PromptRevisor.Result, PromptRevisor.UnavailableError>) =>
      Effect.gen(function* () {
        entry.fiber = fiber
        // A cancel/supersede may have arrived between begin and the fork.
        if (entry.interrupt !== undefined) yield* Effect.forkDetach(Fiber.interrupt(fiber))
      }),
    finish: (exit: Exit.Exit<PromptRevisor.Result, PromptRevisor.UnavailableError>) => finish(entry, exit),
  }
})

const finish = Effect.fn("PromptRevisorRuns.finish")(function* (
  entry: RunEntry,
  exit: Exit.Exit<PromptRevisor.Result, PromptRevisor.UnavailableError>,
) {
  if (runs.get(entry.key) === entry) runs.delete(entry.key)
  // cancel/supersede already settled the Deferred when they interrupted.
  if (entry.interrupt !== undefined) return
  if (exit._tag === "Success") {
    failures.delete(entry.key)
    yield* Deferred.succeed(entry.deferred, exit.value)
    return
  }
  const cause = exit.cause
  const message = Cause.hasInterrupts(cause)
    ? "Prompt revision was interrupted before it completed"
    : (() => {
        const error = Cause.squash(cause)
        return error instanceof Error ? error.message : String(error)
      })()
  recordFailure(entry.key, entry, message)
  yield* Deferred.fail(entry.deferred, new PromptRevisor.UnavailableError({ message }))
})

/**
 * Run `effect` so its lifetime is owned by this registry instead of the HTTP
 * connection that happened to start it. Without a locator (internal callers
 * that do not participate in editor recovery) the effect keeps the original
 * request-scoped semantics: there would be no way to retrieve or cancel an
 * untracked run, so detaching it would only create zombies.
 */
export const runDetached = Effect.fn("PromptRevisorRuns.runDetached")(function* (
  input: DetachInput,
  effect: Effect.Effect<PromptRevisor.Result, PromptRevisor.UnavailableError>,
) {
  const locator = input.locator
  const sourceFingerprint = input.sourceFingerprint
  if (locator === undefined || sourceFingerprint === undefined) return yield* effect
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const run = yield* begin({
        locator,
        sourceFingerprint,
        ...(input.operationID === undefined ? {} : { operationID: input.operationID }),
      })
      // Registration, fork, and fiber binding are atomic with respect to
      // caller interruption: a client abort between `runs.set` and the fork
      // must not leave a zombie entry whose fiber never starts. Only the
      // waiter below is interruptible.
      if (!run.created) return yield* restore(Deferred.await(run.handle.deferred))
      const fiber = yield* effect.pipe(Effect.onExit((exit) => run.finish(exit)), Effect.forkDetach)
      yield* run.bindFiber(fiber)
      return yield* restore(Deferred.await(run.handle.deferred))
    }),
  )
})

export const status = Effect.fn("PromptRevisorRuns.status")(function* (locator: RevisionDraft.Locator) {
  const key = locatorKey(locator)
  evictFailures(Date.now())
  const entry = runs.get(key)
  if (entry) {
    return {
      state: "running" as const,
      sourceFingerprint: entry.sourceFingerprint,
      ...(entry.operationID === undefined ? {} : { operationID: entry.operationID }),
      startedAt: entry.startedAt,
    }
  }
  const failure = failures.get(key)
  if (failure) {
    return {
      state: "failed" as const,
      sourceFingerprint: failure.sourceFingerprint,
      message: failure.message,
      at: failure.at,
    }
  }
  return undefined
})

export const cancel = Effect.fn("PromptRevisorRuns.cancel")(function* (input: {
  readonly locator: RevisionDraft.Locator
  /** When both sides know the correlation id, a mismatched cancel is refused. */
  readonly operationID?: string
}) {
  const entry = runs.get(locatorKey(input.locator))
  if (!entry) return false
  const operationID = RevisionProgress.normalizeOperationID(input.operationID)
  if (operationID !== undefined && entry.operationID !== undefined && entry.operationID !== operationID) return false
  yield* requestInterrupt(entry, "cancel")
  return true
})

export * as PromptRevisorRuns from "./run-registry"
