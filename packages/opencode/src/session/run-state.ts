import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import * as BackgroundJobOwner from "@opencode-ai/core/background-job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperatorRecovery } from "./operator-stop"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { EventV2Bridge } from "@/event-v2-bridge"
import { abortSessionTransports } from "./llm/provider-transport"

type Drain = (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>

type Entry = {
  readonly runner: Runner.Runner<SessionV1.WithParts>
  readonly token: SessionExecutionOwner.Token
  /**
   * Set before explicit cancellation begins. This closes the small handoff
   * window between durable owner acquisition and Runner.ensureRunning() so work
   * that was already admitted locally cannot start provider execution after the
   * generation has been cancelled/released.
   */
  stopping: boolean
}

type ActiveHandle = {
  readonly generation: number
  readonly cancel: (afterJobs: Effect.Effect<void>) => Effect.Effect<boolean>
}

// Session IDs and execution generations are process-global identities. The
// runner itself remains owned by its InstanceState, while this tiny index lets
// a Tier-0/1 control route signal that exact existing runner without waiting for
// InstanceStore/bootstrap. It never admits work or owns a second Runner.
// A module-local Map is not a process-wide registry: distinct bundles or
// runtime module copies (OXP versus desktop/server) can each load this module
// independently, leaving control unable to reach a live Runner in the SAME
// process. Store the handle index behind a stable global symbol, mirroring
// SessionExecutionOwner's process-wide activation registry. The generation
// fence still guards every operation against stale handles after reload.
const ACTIVE_HANDLES_REGISTRY = Symbol.for("openfork.session-run-state.active-handles.v1")
const activeHandles = (() => {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = processGlobal[ACTIVE_HANDLES_REGISTRY]
  if (existing instanceof Map) return existing as Map<SessionID, ActiveHandle>
  const created = new Map<SessionID, ActiveHandle>()
  processGlobal[ACTIVE_HANDLES_REGISTRY] = created
  return created
})()

function forgetActiveHandle(sessionID: SessionID, generation: number) {
  if (activeHandles.get(sessionID)?.generation === generation) activeHandles.delete(sessionID)
}

export const cancelActiveHandle = Effect.fn("SessionRunState.cancelActiveHandle")(function* (
  sessionID: SessionID,
  generation: number,
  afterJobs: Effect.Effect<void> = Effect.void,
) {
  const handle = activeHandles.get(sessionID)
  if (!handle) return "not-running" as const
  if (handle.generation !== generation) return "stale" as const
  return (yield* handle.cancel(afterJobs)) ? ("cancelled" as const) : ("not-running" as const)
})


export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Abort only the current turn execution and exact-release its owner. Unlike
   * cancel(), this preserves Session-owned background jobs.
   */
  readonly preempt: (sessionID: SessionID) => Effect.Effect<void>
  /** Exact live-provider switch fence; refuses tool, compaction, and stale generations. */
  readonly switchProviderAttempt: (input: {
    sessionID: SessionID
    generation: number
    assistantMessageID: string
    requestSentAt: number
  }) => Effect.Effect<boolean>
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
    const status = yield* SessionStatus.Service
    const ownership = yield* SessionExecutionOwner.Service
    const { db } = yield* Database.Service
    const operatorRecovery = yield* SessionOperatorRecovery.Service
    const telemetry = yield* SessionTelemetry.Service
    const events = yield* EventV2Bridge.Service
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
                entry.stopping = true
                const interrupt = yield* ownership.requestInterrupt(sessionID, "shutdown", entry.token.generation)
                // Instance disposal is another cancellation owner. Signal the
                // physical provider socket before awaiting the runner, but
                // ONLY if this instance still owns the durable generation.
                // An old instance teardown must never abort a newer provider
                // request with the same Session ID in another service graph.
                if (
                  interrupt.state === "requested" &&
                  interrupt.token.ownerID === entry.token.ownerID &&
                  interrupt.token.generation === entry.token.generation
                ) yield* Effect.sync(() => abortSessionTransports(sessionID))
                yield* entry.runner.cancel
                // Runner.cancel is normally followed by onIdle, but Runner is
                // already locally Idle while its onIdle callback is releasing
                // durable ownership. Exact release is an idempotent CAS and
                // closes that race (and the pre-start Idle window) during
                // shutdown as well.
                yield* ownership.release(entry.token)
                forgetActiveHandle(sessionID, entry.token.generation)
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
          if (existing) return existing

          let acquired = yield* ownership.tryAcquireLocal(sessionID)
          if (acquired.state === "maintenance-blocked") {
            yield* Effect.logInfo("Session runner admission blocked by directory maintenance", {
              sessionID,
              reason: acquired.reason,
              directory: acquired.directory,
              directoryKey: acquired.directoryKey,
              guards: acquired.guards,
            })
            return yield* busyError(sessionID)
          }
          if (acquired.state === "busy") {
             const recovery = yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, ownership, sessionID, events)
            if (recovery.state === "recovered") acquired = yield* ownership.tryAcquireLocal(sessionID)
             else if (recovery.state === "effect-unknown" || recovery.state === "transcript-unverifiable")
               yield* Effect.logWarning("Session recovery remains fenced by unresolved execution evidence", {
                 sessionID,
                 generation: recovery.token.generation,
                 ...(recovery.state === "effect-unknown" ? { hazards: recovery.hazards } : { reason: recovery.reason }),
              })
          }
          if (acquired.state === "maintenance-blocked") {
            yield* Effect.logInfo("Session runner admission became maintenance-blocked after recovery", {
              sessionID,
              reason: acquired.reason,
              directory: acquired.directory,
              directoryKey: acquired.directoryKey,
              guards: acquired.guards,
            })
            return yield* busyError(sessionID)
          }
          if (acquired.state === "busy") return yield* busyError(sessionID)
          const token = acquired.token
          // Ownerless incomplete calls are interrupted evidence, not new work.
          // Operator recovery must seal them before admitting another executor.
          // This also makes a failed ownerless repair reservation retryable.
          const hazards = yield* SessionRecovery.executionHazards(db, sessionID)
          if (hazards.currentTool || hazards.legacyTool) {
            yield* ownership.release(token)
            return yield* busyError(sessionID)
          }
          let entry!: Entry
          let next!: Runner.Runner<SessionV1.WithParts>
          next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: Effect.gen(function* () {
              const current = data.runners.get(sessionID)
              if (!current || current !== entry || current.token.generation !== token.generation) return

              const aborted = data.cancelled.has(sessionID)
              const forced = entry.stopping || data.forceRelease.has(sessionID)
              const released = forced ? yield* ownership.release(token) : yield* ownership.releaseIfDrained(token)
              if (released !== "continue") {
                if (data.runners.get(sessionID) === entry) data.runners.delete(sessionID)
                forgetActiveHandle(sessionID, token.generation)
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
                if (data.runners.get(sessionID) === entry) data.runners.delete(sessionID)
                forgetActiveHandle(sessionID, token.generation)
                if (exact === "released") yield* status.set(sessionID, { type: "idle" })
                return
              }

              // Cancellation can race this exact boundary: releaseIfDrained()
              // observed pending input and returned "continue" while the Runner
              // itself is already Idle. Re-check the local generation fence
              // before starting the next drain so an explicit stop cannot
              // resurrect work after establishing quiescence.
              if (entry.stopping || data.forceRelease.has(sessionID)) {
                const exact = yield* ownership.release(token)
                if (data.runners.get(sessionID) === entry) data.runners.delete(sessionID)
                forgetActiveHandle(sessionID, token.generation)
                data.forceRelease.delete(sessionID)
                if (exact === "released")
                  yield* status.set(sessionID, { type: "idle" }, data.cancelled.has(sessionID) ? "aborted" : undefined)
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
              yield* next.ensureRunning(
                Effect.suspend(() => (entry.stopping ? onInterrupt : continued)),
              ).pipe(
                Effect.forkIn(data.scope, { startImmediately: true }),
                Effect.asVoid,
              )
            }),
            onBusy: status.set(sessionID, { type: "busy" }),
            onInterrupt,
          })
          entry = { runner: next, token, stopping: false }
          data.runners.set(sessionID, entry)
          let handle!: ActiveHandle
          handle = {
            generation: token.generation,
            cancel: (afterJobs) => Effect.suspend(() => {
              if (activeHandles.get(sessionID) !== handle || data.runners.get(sessionID) !== entry) {
                return Effect.succeed(false)
              }
              return BackgroundJobOwner.cancelOwnedBySession(
                sessionID,
                afterJobs.pipe(Effect.andThen(cancelEntry(data, entry)), Effect.asVoid),
              ).pipe(Effect.as(true))
            }),
          }
          activeHandles.set(sessionID, handle)
          return entry
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

    const cancelEntry = Effect.fn("SessionRunState.cancelEntry")(function* (
      data: { runners: Map<SessionID, Entry>; cancelled: Set<SessionID>; forceRelease: Set<SessionID> },
      existing: Entry,
      /** Owner generation already proven by a successful requestInterrupt CAS. */
      interruptConfirmed = false,
    ) {
      const sessionID = existing.token.sessionID
      if (data.runners.get(sessionID) !== existing) return false
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // cancel() is an execution barrier, not merely a best-effort interrupt
          // request. Once this local generation is marked stopping, caller
          // interruption (for example an HTTP disconnect) must not strand the
          // registry entry or durable owner halfway through quiescence.
          existing.stopping = true
          data.forceRelease.add(sessionID)
          data.cancelled.add(sessionID)
          try {
            // Signal the physical provider HTTP/SDK transport before joining
            // the runner interrupt, but only for this exact durable owner
            // generation. A stale local runner may coexist briefly with a
            // successor; aborting all transports by Session ID would revoke
            // the successor's live request.
            // The normal Stop / provider-switch caller already has a durable
            // generation proof from requestInterrupt. Do not add another
            // SQLite read to the cancellation hot path under writer contention.
            // Independently invoked active-handle cancellation still verifies
            // its generation here before signalling any physical transport.
            const current = interruptConfirmed ? undefined : yield* ownership.snapshot(sessionID)
            if (
              interruptConfirmed ||
              (current?.ownerID === existing.token.ownerID &&
                current?.generation === existing.token.generation)
            ) yield* Effect.sync(() => abortSessionTransports(sessionID))
            yield* existing.runner.cancel
            // Runner transitions its local state to Idle before its onIdle callback
            // finishes. Exact release is safe to race with onIdle: one side releases
            // this generation and the other observes "stale".
            const released = yield* ownership.release(existing.token)
            if (data.runners.get(sessionID) === existing) data.runners.delete(sessionID)
            data.forceRelease.delete(sessionID)
            forgetActiveHandle(sessionID, existing.token.generation)
            if (released === "released") yield* status.set(sessionID, { type: "idle" }, "aborted")
          } finally {
            data.cancelled.delete(sessionID)
          }
          return true
        }),
      )
    })

    const stopCurrent = Effect.fn("SessionRunState.stopCurrent")(function* (
      sessionID: SessionID,
      reason: "operator" | "handoff",
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const interrupt = yield* ownership.requestInterrupt(sessionID, reason, existing?.token.generation)
      if (!existing) {
        // InstanceState can be different across route/worker scopes even when a
        // live Runner is registered in this process. Reach the exact generation
        // through the global activation handle before treating it as remote.
        if (reason === "operator" && interrupt.state === "requested") {
          const controlled = yield* cancelActiveHandle(sessionID, interrupt.token.generation)
          if (controlled === "cancelled") return
        }
        // If another process owns the Session, the durable interrupt request is
        // authoritative. Publishing idle here would race/falsify its live state.
        if (reason === "operator" && interrupt.state !== "stale") {
          const snapshot = yield* ownership.snapshot(sessionID)
          const recovered = yield* operatorRecovery.recover(sessionID,
            interrupt.state === "requested" ? interrupt.token.generation : snapshot.generation)
          if (recovered === "uncontained" || recovered === "stale" || recovered === "live")
            return yield* Effect.die(new Error("Session Stop could not quiesce its live execution owner; no successful cancellation is claimed."))
        }
        if (interrupt.state === "idle" && !(yield* ownership.snapshot(sessionID)).ownerID)
          yield* status.set(sessionID, { type: "idle" }, "aborted")
        return
      }
      return yield* cancelEntry(data, existing,
        interrupt.state === "requested" &&
        interrupt.token.ownerID === existing.token.ownerID &&
        interrupt.token.generation === existing.token.generation)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* BackgroundJobOwner.cancelOwnedBySession(sessionID)
      yield* stopCurrent(sessionID, "operator")
    })

    const preempt = Effect.fn("SessionRunState.preempt")((sessionID: SessionID) =>
      stopCurrent(sessionID, "handoff"),
    )

    const switchProviderAttempt = Effect.fn("SessionRunState.switchProviderAttempt")(function* (input: {
      sessionID: SessionID
      generation: number
      assistantMessageID: string
      requestSentAt: number
    }) {
      const data = yield* InstanceState.get(state)
      const entry = data.runners.get(input.sessionID)
      if (!entry || entry.token.generation !== input.generation || entry.stopping) return false

      const claimed = yield* telemetry.claimModelSwitchAttempt({
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        requestSentAt: input.requestSentAt,
      })
      if (!claimed) return false

      const requested = yield* ownership.requestInterrupt(input.sessionID, "handoff", input.generation)
      if (requested.state !== "requested") return false
      return yield* cancelEntry(data, entry,
        requested.token.ownerID === entry.token.ownerID &&
        requested.token.generation === entry.token.generation)
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
      const entry = yield* runner(sessionID, onInterrupt)
      if (entry.stopping) return yield* onInterrupt
      const result = yield* entry.runner.ensureRunning(
        Effect.suspend(() => (entry.stopping ? onInterrupt : work)),
      )
      if (entry.stopping) {
        // If cancel won the tiny pre-start race, Runner.onBusy may have fired
        // after the generation was already released. Never leave a false busy
        // projection behind; only publish idle when durable ownership is truly
        // absent so a newer owner cannot be overwritten.
        const snapshot = yield* ownership.snapshot(sessionID)
        if (!snapshot.ownerID) yield* status.set(sessionID, { type: "idle" }, "aborted")
      }
      return result
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      const entry = yield* runner(sessionID, onInterrupt)
      if (entry.stopping) return yield* onInterrupt
      const result = yield* entry.runner
        .startShell(Effect.suspend(() => (entry.stopping ? onInterrupt : work)), ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
      if (entry.stopping) {
        const snapshot = yield* ownership.snapshot(sessionID)
        if (!snapshot.ownerID) yield* status.set(sessionID, { type: "idle" }, "aborted")
      }
      return result
    })

    const registerDrain = Effect.fn("SessionRunState.registerDrain")((next: Drain) =>
      Effect.sync(() => {
        drain = next
      }),
    )

    return Service.of({ assertNotBusy, cancel, preempt, switchProviderAttempt, deferPending, registerDrain, ensureRunning, startShell })
  }),
)

export const cancelSessionBackgroundJobs = BackgroundJobOwner.cancelOwnedBySession

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [SessionStatus.node, SessionExecutionOwner.node, Database.node, SessionOperatorRecovery.node, SessionTelemetry.node, EventV2Bridge.node]
})

export * as SessionRunState from "./run-state"
