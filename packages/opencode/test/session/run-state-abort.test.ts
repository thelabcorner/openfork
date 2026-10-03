import { expect, spyOn } from "bun:test"
import { mkdir, rm } from "fs/promises"
import { join } from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session/session"
import { Runner } from "../../src/effect/runner"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * t-manual-stop (opencode side): an operator cancel must be OBSERVABLE.
 *
 * The idle transition caused by SessionRunState.cancel publishes
 * session.idle with reason:"aborted" so downstream consumers (swarm
 * supervisors) can distinguish an operator stop from a natural turn end
 * and never auto-resume it. A naturally-completing run publishes the same
 * event WITHOUT the reason.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      RuntimeOwner.node,
      SessionExecutionOwner.node,
      DirectoryMaintenanceGuard.node,
      SessionRunState.node,
      EventV2Bridge.node,
    ]),
  ),
)

const work = Effect.succeed({} as SessionV1.WithParts)

it.effect("drain registration is process-scoped and does not require an active InstanceRef", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    yield* runState.registerDrain(() => work)
  }),
)

const seedSession = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const instance = yield* requireInstance
    yield* db
      .insert(ProjectTable)
      .values({
        id: instance.project.id ?? Project.ID.global,
        worktree: AbsolutePath.make(instance.worktree),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: instance.project.id ?? Project.ID.global,
        slug: sessionID,
        directory: instance.directory,
        title: "run-state test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** Register a listener that resolves on the next session.idle payload. The
 * listener is attached synchronously (no pubsub subscription race). */
const nextIdle = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<any>()
  yield* events.listen((event) =>
    event.type === "session.idle" ? Deferred.succeed(deferred, event as any) : Effect.void,
  )
  return deferred
})

it.instance("operator cancel publishes session.idle with reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const sessionID = SessionID.make("session-abort-test")
    yield* seedSession(sessionID)

    const fiber = yield* nextIdle
    yield* Effect.forkChild(runState.ensureRunning(sessionID, work, Effect.never))
    yield* Effect.sleep("50 millis")
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.type).toBe("session.idle")
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
    // cancel() is an execution barrier, not merely an interrupt request. A
    // caller that returns from it may immediately hand the Session to another
    // owner (Goal Auditor preemption relies on this exact invariant).
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
    yield* runState.assertNotBusy(sessionID)
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("process control handle cancels the exact active generation without an InstanceRef", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const sessionID = SessionID.make("session-global-control-handle")
    yield* seedSession(sessionID)

    const running = yield* runState.ensureRunning(sessionID, work, Effect.never).pipe(Effect.forkChild)
    yield* Effect.sleep("50 millis")

    const observed = yield* owner.snapshot(sessionID)
    expect(observed.ownerID).toBeDefined()
    const stale = yield* SessionRunState.cancelActiveHandle(sessionID, observed.generation + 1)
    expect(stale).toBe("stale")
    expect((yield* owner.snapshot(sessionID)).ownerID).toBe(observed.ownerID)

    const interrupt = yield* owner.requestInterrupt(sessionID, "operator", observed.generation)
    expect(interrupt.state).toBe("requested")
    const cancelled = yield* SessionRunState.cancelActiveHandle(sessionID, observed.generation)
    expect(cancelled).toBe("cancelled")
    yield* Fiber.await(running)
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("local cancel fences its durable interrupt to the registered generation", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const sessionID = SessionID.make("session-local-cancel-generation-fence")
    yield* seedSession(sessionID)

    const running = yield* runState.ensureRunning(sessionID, work, Effect.never).pipe(Effect.forkChild)
    yield* Effect.sleep("50 millis")
    const previous = yield* owner.snapshot(sessionID)
    expect(previous.ownerID).toBeDefined()
    yield* owner.release({ sessionID, ownerID: previous.ownerID!, generation: previous.generation })
    const next = yield* owner.tryAcquireLocal(sessionID)
    expect(next.state).toBe("acquired")
    if (next.state !== "acquired") return

    yield* runState.cancel(sessionID)
    yield* Fiber.await(running)
    const current = yield* owner.snapshot(sessionID)
    expect(current.ownerID).toBe(next.token.ownerID)
    expect(current.generation).toBe(next.token.generation)
    yield* owner.release(next.token)
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("bootstrap-independent control reaches 1, 3, and 6 active session handles", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service

    for (const count of [1, 3, 6]) {
      const ids = Array.from({ length: count }, (_, index) =>
        SessionID.make(`session-global-control-${count}-${index}`),
      )
      yield* Effect.forEach(ids, seedSession, { concurrency: 1, discard: true })
      const blockers = ids.map((sessionID) =>
        runState.ensureRunning(sessionID, work, Effect.never),
      )
      const fibers = yield* Effect.forEach(blockers, (effect) => effect.pipe(Effect.forkChild), {
        concurrency: 1,
      })
      yield* Effect.sleep("50 millis")
      const snapshots = yield* Effect.forEach(ids, (sessionID) => owner.snapshot(sessionID), {
        concurrency: count,
      })
      yield* Effect.forEach(
        ids.map((sessionID, index) => owner.requestInterrupt(sessionID, "operator", snapshots[index]!.generation)),
        (effect) => effect,
        { concurrency: count, discard: true },
      )
      const results = yield* Effect.forEach(
        snapshots.map((snapshot, index) =>
          SessionRunState.cancelActiveHandle(ids[index]!, snapshot.generation),
        ),
        (effect) => effect,
        { concurrency: count },
      )
      expect(results).toEqual(Array.from({ length: count }, () => "cancelled"))
      yield* Effect.forEach(fibers, Fiber.await, { concurrency: count, discard: true })
      for (const sessionID of ids) expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
    }
  }).pipe(Effect.timeout("20 seconds")),
)

it.instance("cancel with no active run still publishes reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-abort-noop")

    const fiber = yield* nextIdle
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("natural completion publishes session.idle without a reason", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-natural-idle")
    yield* seedSession(sessionID)

    const fiber = yield* nextIdle
    yield* Effect.sleep("20 millis")
    yield* runState.ensureRunning(sessionID, work, work)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("concurrent ensureRunning callers join one physical Session execution", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-single-physical-run")
    yield* seedSession(sessionID)

    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let physicalRuns = 0
    const blockingWork = Effect.gen(function* () {
      physicalRuns += 1
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      return {} as SessionV1.WithParts
    })

    const first = yield* runState.ensureRunning(sessionID, work, blockingWork).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const second = yield* runState.ensureRunning(sessionID, work, Effect.sync(() => {
      physicalRuns += 100
      return {} as SessionV1.WithParts
    })).pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    expect(physicalRuns).toBe(1)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.await(first)
    yield* Fiber.await(second)
    expect(physicalRuns).toBe(1)
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("pending SessionInput continues under the same durable owner generation before release", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const { db } = yield* Database.Service
    const sessionID = SessionID.make("session-owner-drain-continuation")
    yield* seedSession(sessionID)

    const firstGeneration = yield* Ref.make<number | undefined>(undefined)
    const drainedGeneration = yield* Ref.make<number | undefined>(undefined)
    const drained = yield* Deferred.make<void>()
    yield* runState.registerDrain((id) =>
      Effect.gen(function* () {
        const snapshot = yield* owner.snapshot(id)
        yield* Ref.set(drainedGeneration, snapshot.generation)
        yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
        yield* Deferred.succeed(drained, undefined)
        return {} as SessionV1.WithParts
      }),
    )

    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make("msg_run_state_pending"),
        session_id: sessionID,
        prompt: Prompt.make({ text: "pending" }),
        delivery: "queue",
        admitted_seq: 1,
      })
      .run()
      .pipe(Effect.orDie)

    yield* runState.ensureRunning(
      sessionID,
      work,
      Effect.gen(function* () {
        yield* Ref.set(firstGeneration, (yield* owner.snapshot(sessionID)).generation)
        return {} as SessionV1.WithParts
      }),
    )
    yield* Deferred.await(drained)
    expect(yield* Ref.get(drainedGeneration)).toBe(yield* Ref.get(firstGeneration))

    for (let index = 0; index < 100; index++) {
      if (!(yield* owner.snapshot(sessionID)).ownerID) break
      yield* Effect.sleep("10 millis")
    }
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("recovers a same-runtime durable owner with no canonical local runner", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const sessionID = SessionID.make("session-run-state-local-orphan")
    yield* seedSession(sessionID)

    // Reproduce the brick directly: durable ownership was published by this
    // runtime, but SessionRunState has no runner entry that can ever release it.
    const orphan = yield* owner.tryAcquire(sessionID)
    if (orphan.state !== "acquired") return yield* Effect.die("Expected synthetic local orphan acquisition")
    const orphanGeneration = orphan.token.generation

    let runs = 0
    const localWork = Effect.sync(() => {
      runs++
      return {} as SessionV1.WithParts
    })
    yield* runState.ensureRunning(sessionID, localWork, localWork)

    expect(runs).toBe(1)
    expect((yield* owner.snapshot(sessionID)).generation).toBe(orphanGeneration + 1)

    for (let index = 0; index < 100; index++) {
      if (!(yield* owner.snapshot(sessionID)).ownerID) break
      yield* Effect.sleep("10 millis")
    }
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)


it.instance("maintenance guard blocks SessionRunState before recovery or Runner construction", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const guard = yield* DirectoryMaintenanceGuard.Service
    const instance = yield* requireInstance
    const sessionID = SessionID.make("session-run-state-maintenance-blocked")
    yield* seedSession(sessionID)

    const peer = join(instance.directory, ".g2-maintenance-peer-immediate")
    yield* Effect.promise(() => mkdir(peer, { recursive: true }))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(peer, { recursive: true, force: true })))

    const acquired = yield* guard.acquire({
      guardId: "run-state-maintenance-immediate",
      directories: [instance.directory, peer],
    })
    if (acquired.state !== "acquired") return yield* Effect.die("Expected test maintenance guard acquisition")
    yield* Effect.addFinalizer(() => guard.release(acquired.token).pipe(Effect.asVoid))

    const recoverySpy = spyOn(SessionRecovery, "recoverDeadOwnerIfQuiescent")
    const runnerSpy = spyOn(Runner, "make")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        recoverySpy.mockRestore()
        runnerSpy.mockRestore()
      }),
    )

    let workRuns = 0
    const guardedWork = Effect.sync(() => {
      workRuns++
      return {} as SessionV1.WithParts
    })

    const error = yield* runState.ensureRunning(sessionID, guardedWork, guardedWork).pipe(Effect.flip)

    expect(error).toBeInstanceOf(Session.BusyError)
    expect(recoverySpy.mock.calls.length).toBe(0)
    expect(runnerSpy.mock.calls.length).toBe(0)
    expect(workRuns).toBe(0)
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("busy recovery retry stops when maintenance becomes authoritative", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const guard = yield* DirectoryMaintenanceGuard.Service
    const instance = yield* requireInstance
    const sessionID = SessionID.make("session-run-state-recovery-maintenance")
    yield* seedSession(sessionID)

    const peer = join(instance.directory, ".g2-maintenance-peer-recovery")
    yield* Effect.promise(() => mkdir(peer, { recursive: true }))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(peer, { recursive: true, force: true })))

    let guardToken: DirectoryMaintenanceGuard.Token | undefined
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => (guardToken ? guard.release(guardToken).pipe(Effect.asVoid) : Effect.void)),
    )

    const originalTryAcquire = owner.tryAcquireLocal
    let tryAcquireCalls = 0
    const tryAcquireSpy = spyOn(owner, "tryAcquireLocal").mockImplementation((id) => {
      tryAcquireCalls++
      if (tryAcquireCalls === 1) {
        return Effect.succeed({
          state: "busy" as const,
          snapshot: {
            sessionID: id,
            generation: 41,
            ownerID: "synthetic-dead-owner" as RuntimeOwner.ID,
          },
        })
      }
      return originalTryAcquire(id)
    })

    const recoveryToken: SessionExecutionOwner.RecoveryToken = {
      sessionID,
      ownerID: "synthetic-dead-owner" as RuntimeOwner.ID,
      generation: 41,
      recoveryOwnerID: "synthetic-recovery-owner" as RuntimeOwner.ID,
    }
    const recoverySpy = spyOn(SessionRecovery, "recoverDeadOwnerIfQuiescent").mockImplementation(
      () =>
        Effect.gen(function* () {
          const acquired = yield* guard
            .acquire({
              guardId: "run-state-maintenance-after-recovery",
              directories: [instance.directory, peer],
            })
            .pipe(Effect.orDie)
          if (acquired.state !== "acquired") return yield* Effect.die("Expected recovery-time guard acquisition")
          guardToken = acquired.token
          return { state: "recovered" as const, token: recoveryToken }
        }),
    )
    const runnerSpy = spyOn(Runner, "make")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        tryAcquireSpy.mockRestore()
        recoverySpy.mockRestore()
        runnerSpy.mockRestore()
      }),
    )

    let workRuns = 0
    const guardedWork = Effect.sync(() => {
      workRuns++
      return {} as SessionV1.WithParts
    })

    const error = yield* runState.ensureRunning(sessionID, guardedWork, guardedWork).pipe(Effect.flip)

    expect(error).toBeInstanceOf(Session.BusyError)
    expect(tryAcquireCalls).toBe(2)
    expect(recoverySpy.mock.calls.length).toBe(1)
    expect(runnerSpy.mock.calls.length).toBe(0)
    expect(workRuns).toBe(0)
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)


it.instance("cancel remains an execution barrier when the cancel caller is interrupted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const sessionID = SessionID.make("session-cancel-caller-interrupted")
    yield* seedSession(sessionID)

    const started = yield* Deferred.make<void>()
    const cleanupStarted = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()

    const blockingWork = Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined)
      return yield* Effect.never
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(cleanupStarted, undefined)
          yield* Deferred.await(releaseCleanup)
        }),
      ),
    )

    const runFiber = yield* runState.ensureRunning(sessionID, work, blockingWork).pipe(Effect.forkChild)
    yield* Deferred.await(started)

    const cancelFiber = yield* runState.cancel(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(cleanupStarted)

    // Reproduce an HTTP/client disconnect while cancel() is itself waiting for
    // the running turn's finalizers. A true execution barrier must finish the
    // quiescence + exact owner release before honoring this interruption.
    const interruptFiber = yield* Fiber.interrupt(cancelFiber).pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Fiber.await(interruptFiber)
    yield* Fiber.await(runFiber)

    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
    yield* runState.assertNotBusy(sessionID)
  }).pipe(Effect.timeout("5 seconds")),
)
