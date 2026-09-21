import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { Database } from "@opencode-ai/core/database/database"

type Drain = (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>

type Entry = {
  readonly runner: Runner.Runner<SessionV1.WithParts>
  readonly token: SessionExecutionOwner.Token
}

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Keep durable inbox work pending while allowing the current local activation
   * to quiesce and exact-release its owner generation (for example while the
   * Session is paused). This is not an abort and does not discard input.
   */
  readonly deferPending: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Registers the Session-owned provider drain used when durable inbox work
   * commits before this process releases an otherwise-idle execution owner.
   * The callback is process-local activation only; SessionInput remains the
   * durable wake source.
   */
  readonly registerDrain: (drain: Drain) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const ownership = yield* SessionExecutionOwner.Service
    const { db } = yield* Database.Service
    const runnerLocks = KeyedMutex.makeUnsafe<SessionID>()
    // Provider draining is one SessionRunState service-level algorithm, not
    // per-directory mutable state. Register it once when SessionPrompt boots;
    // every location-scoped runner consults the same callback lazily.
    let drain: Drain | undefined

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Entry>()
        // Sessions whose current run was cancelled via an explicit cancel()
        // (operator stop). The runner's onIdle callback consults this so the
        // resulting idle transition is published with reason "aborted" —
        // consumers (e.g. swarm supervisors) can tell an operator stop from a
        // natural turn end. Added before existing.cancel and removed after it
        // settles, since onIdle fires synchronously inside cancel.
        const cancelled = new Set<SessionID>()
        // Explicit cancellation/shutdown has already established a quiescence
        // barrier. Its onIdle path must exact-release ownership even if durable
        // inbox work remains; that work stays pending for a later explicit wake.
        const forceRelease = new Set<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.entries(), ([sessionID, entry]) =>
              Effect.gen(function* () {
                forceRelease.add(sessionID)
                yield* ownership.requestInterrupt(sessionID, "shutdown")
                yield* entry.runner.cancel
              }), {
              concurrency: 8,
              discard: true,
            })
            runners.clear()
          }),
        )
        return {
          runners,
          scope,
          cancelled,
          forceRelease,
        }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* runnerLocks.withLock(sessionID)(
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          const existing = data.runners.get(sessionID)
          if (existing) return existing.runner

          let acquired = yield* ownership.tryAcquire(sessionID)
          if (acquired.state === "busy") {
            const recovery = yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, ownership, sessionID)
            if (recovery.state === "recovered") acquired = yield* ownership.tryAcquire(sessionID)
            else if (recovery.state === "effect-unknown")
              yield* Effect.logWarning("Session recovery remains fenced by unresolved execution effects", {
                sessionID,
                generation: recovery.token.generation,
                hazards: recovery.hazards,
              })
          }
          if (acquired.state === "busy") return yield* busyError(sessionID)
          const token = acquired.token
          let next!: Runner.Runner<SessionV1.WithParts>
          next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: Effect.gen(function* () {
              const current = data.runners.get(sessionID)
              if (!current || current.runner !== next || current.token.generation !== token.generation) return

              const aborted = data.cancelled.has(sessionID)
              const forced = data.forceRelease.has(sessionID)
              const released = forced ? yield* ownership.release(token) : yield* ownership.releaseIfDrained(token)
              if (released !== "continue") {
                if (data.runners.get(sessionID)?.runner === next) data.runners.delete(sessionID)
                data.forceRelease.delete(sessionID)
                // A stale local token means a newer owner is authoritative. Do
                // not publish a false idle transition over that newer runtime.
                if (released === "released")
                  yield* status.set(sessionID, { type: "idle" }, aborted ? "aborted" : undefined)
                return
              }

              const registeredDrain = drain
              if (!registeredDrain) {
                yield* Effect.logError("Session owner retained pending inbox work without a registered drain", {
                  sessionID,
                  generation: token.generation,
                })
                const exact = yield* ownership.release(token)
                if (data.runners.get(sessionID)?.runner === next) data.runners.delete(sessionID)
                if (exact === "released") yield* status.set(sessionID, { type: "idle" })
                return
              }

              // Runner is already locally Idle when onIdle executes. Start a
              // fresh provider drain under the SAME durable generation. If the
              // drain fails, mark this generation for exact release on its next
              // idle callback rather than spinning forever on pending work.
              const continued = registeredDrain(sessionID).pipe(
                Effect.onError((cause) =>
                  Effect.sync(() => data.forceRelease.add(sessionID)).pipe(
                    Effect.andThen(
                      Effect.logError("Session durable inbox continuation failed", { sessionID, cause }),
                    ),
                  ),
                ),
              )
              yield* next.ensureRunning(continued).pipe(
                Effect.forkIn(data.scope, { startImmediately: true }),
                Effect.asVoid,
              )
            }),
            onBusy: status.set(sessionID, { type: "busy" }),
            onInterrupt,
          })
          data.runners.set(sessionID, { runner: next, token })
          return next
        }),
      )
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return yield* busyError(sessionID)
      const snapshot = yield* ownership.snapshot(sessionID)
      if (snapshot.ownerID) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const interrupt = yield* ownership.requestInterrupt(sessionID, "operator")
      if (!existing) {
        // If another process owns the Session, the durable interrupt request is
        // authoritative. Publishing idle here would race/falsify its live state.
        if (interrupt.state === "idle") yield* status.set(sessionID, { type: "idle" }, "aborted")
        return
      }
      data.forceRelease.add(sessionID)
      data.cancelled.add(sessionID)
      try {
        yield* existing.runner.cancel
      } finally {
        data.cancelled.delete(sessionID)
      }
    })

    const deferPending = Effect.fn("SessionRunState.deferPending")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      if (data.runners.has(sessionID)) data.forceRelease.add(sessionID)
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const registerDrain = Effect.fn("SessionRunState.registerDrain")((next: Drain) =>
      Effect.sync(() => {
        drain = next
      }),
    )

    return Service.of({ assertNotBusy, cancel, deferPending, registerDrain, ensureRunning, startShell })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    // Detached task work is session-owned, not parent-turn-owned. Stopping a
    // parent generation must not kill background children that are expected to
    // finish independently and report back later. Cancelling the child session
    // itself still owns and cancels its job.
    if (job.id === sessionID || job.metadata?.sessionId === sessionID) return true
    if (job.metadata?.background === true) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: 8, discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, SessionStatus.node, SessionExecutionOwner.node, Database.node],
})

export * as SessionRunState from "./run-state"
