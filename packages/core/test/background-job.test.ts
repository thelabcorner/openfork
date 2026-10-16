import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("cancels session-owned live handles without scanning retained history", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const parent = yield* jobs.start({ id: "owned_parent_job", type: "test", metadata: { sessionId: "owner_session" }, run: Effect.never })
      const child = yield* jobs.start({ id: "owned_child_job", type: "test", metadata: { parentSessionId: "owner_session" }, run: Effect.never })
      const detached = yield* jobs.start({
        id: "detached_child_job",
        type: "test",
        metadata: { parentSessionId: "owner_session", background: true },
        run: Effect.never,
      })
      const directDetached = yield* jobs.start({
        id: "direct_detached_job",
        type: "test",
        metadata: { sessionId: "owner_session", background: true },
        run: Effect.never,
      })

      yield* BackgroundJob.cancelOwnedBySession("owner_session")

      expect((yield* jobs.get(parent.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(detached.id))?.status).toBe("running")
      expect((yield* jobs.get(directDetached.id))?.status).toBe("cancelled")
      yield* jobs.cancel(detached.id)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("generation-fences a saved job cancellation handle after id reuse", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const old = yield* jobs.start({ id: "reused_job_id", type: "test", metadata: { sessionId: "reused_owner" }, run: Effect.succeed("done") })
      yield* jobs.wait({ id: old.id })
      const current = yield* jobs.start({ id: old.id, type: "test", metadata: { sessionId: "different_owner" }, run: Effect.never })

      yield* BackgroundJob.cancelOwnedBySession("reused_owner")

      expect(current.generation).toBeGreaterThan(old.generation ?? 0)
      expect((yield* jobs.get(current.id))?.status).toBe("running")
      yield* jobs.cancel(current.id)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("delayed Stop cancels only jobs admitted before its exact observation cutoff", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessionID = "stop_epoch_session"
      const old = yield* jobs.start({
        id: "old_job_before_stop", type: "test", metadata: { sessionId: sessionID }, run: Effect.never,
      })
      const cutoff = BackgroundJob.captureSessionJobCancellationCutoff()
      // A newer generation admits this job while Stop is awaiting SQLite.
      const fresh = yield* jobs.start({
        id: "new_job_after_stop", type: "test", metadata: { sessionId: sessionID }, run: Effect.never,
      })
      yield* BackgroundJob.cancelOwnedBySession(sessionID, Effect.void, cutoff)
      expect((yield* jobs.get(old.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(fresh.id))?.status).toBe("running")
      yield* jobs.cancel(fresh.id)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("keeps the session admission fence through local-runner teardown", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "fence_before_job", type: "test", metadata: { sessionId: "fenced_session" }, run: Effect.never })
      let admittedDuringTeardown: BackgroundJob.Info | undefined
      yield* BackgroundJob.cancelOwnedBySession(
        "fenced_session",
        jobs.start({
          id: "fence_during_teardown",
          type: "test",
          metadata: { sessionId: "fenced_session" },
          run: Effect.never,
        }).pipe(Effect.tap((job) => Effect.sync(() => (admittedDuringTeardown = job))), Effect.asVoid),
      )
      expect(admittedDuringTeardown).toBeTruthy()
      expect((yield* jobs.get("fence_during_teardown"))?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("keeps one session fence authoritative while unrelated cancellation advances admission", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const teardownStarted = yield* Deferred.make<void>()
      const releaseTeardown = yield* Deferred.make<void>()
      const cancelA = yield* BackgroundJob.cancelOwnedBySession(
        "fenced_session_a",
        Deferred.succeed(teardownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTeardown)),
        ),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(teardownStarted)
      // Advance the process-global clock while A's fence is still active.
      // A job admitted below must remain older than A's exact fence, not inherit
      // an epoch derived from this unrelated cancellation.
      yield* BackgroundJob.cancelOwnedBySession("unrelated_session_b")

      const admitted = yield* jobs.start({
        id: "fenced_session_a_during_unrelated_cancel",
        type: "test",
        metadata: { sessionId: "fenced_session_a" },
        run: Effect.never,
      })
      expect(admitted.status).toBe("running")

      yield* Deferred.succeed(releaseTeardown, undefined)
      yield* Fiber.join(cancelA)
      expect((yield* jobs.get(admitted.id))?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )

  it.live("indexes one completion signal across 100 workers without unrelated wakeups", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const gates = yield* Effect.forEach(Array.from({ length: 100 }), () => Deferred.make<void>())
      const current = yield* Effect.forEach(gates, (gate, index) =>
        jobs.start({ id: `batch_wait_${index}`, type: "test", run: Deferred.await(gate).pipe(Effect.as(`done_${index}`)) }),
      )
      const targets = current.map(({ id, generation }) => ({ id, generation }))
      const unrelated = yield* jobs.start({ id: "batch_wait_unrelated", type: "test", run: Effect.succeed("unrelated") })
      expect((yield* jobs.wait({ id: unrelated.id })).info?.status).toBe("completed")
      expect(yield* jobs.waitAny({ jobs: targets, timeout: 25 })).toEqual({ timedOut: true })
      const watcher = yield* jobs.waitAny({ jobs: targets, timeout: 5_000 }).pipe(Effect.forkChild)
      yield* Deferred.succeed(gates[73]!, undefined)
      expect(yield* Fiber.join(watcher)).toEqual({ timedOut: false })
      expect((yield* jobs.get(current[73]!.id))?.status).toBe("completed")
      expect((yield* jobs.get(current[74]!.id))?.status).toBe("running")
      yield* Effect.forEach(current, (job, index) =>
        index === 73 ? Effect.void : jobs.cancel(job.id).pipe(Effect.asVoid),
        { discard: true },
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not miss immediately completed jobs and fences reused job generations", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const old = yield* jobs.start({ id: "batch_wait_recycled", type: "test", run: Effect.succeed("old") })
      yield* jobs.wait({ id: old.id })
      expect(yield* jobs.waitAny({ jobs: [{ id: old.id, generation: old.generation }], timeout: 5_000 }))
        .toEqual({ timedOut: false })
      const renewed = yield* jobs.start({ id: old.id, type: "test", run: Effect.never })
      expect(renewed.generation).toBe((old.generation ?? 0) + 1)
      expect(yield* jobs.waitAny({ jobs: [{ id: renewed.id, generation: old.generation }], timeout: 5_000 }))
        .toEqual({ timedOut: false })
      expect(yield* jobs.waitAny({ jobs: [{ id: renewed.id, generation: renewed.generation }], timeout: 15 }))
        .toEqual({ timedOut: true })
      yield* jobs.cancel(renewed.id)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts pending indexed batch waits without interrupting worker execution", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const active = yield* jobs.start({ id: "batch_wait_interrupt", type: "test", run: Effect.never })
      for (let iteration = 0; iteration < 50; iteration++) {
        const waiter = yield* jobs.waitAny({ jobs: [{ id: active.id }], timeout: 20_000 }).pipe(Effect.forkChild)
        yield* Fiber.interrupt(waiter)
      }
      expect((yield* jobs.get(active.id))?.status).toBe("running")
      yield* jobs.cancel(active.id)
      expect(yield* jobs.waitAny({ jobs: [{ id: active.id }], timeout: 500 })).toEqual({ timedOut: false })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("reads a consistent batch of job projections with no missing or duplicate entries", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const pending = yield* jobs.start({ id: "batch_projection_running", type: "test", metadata: { owner: "worker" }, run: Effect.never })
      const finished = yield* jobs.start({ id: "batch_projection_finished", type: "test", run: Effect.succeed("ready") })
      yield* jobs.wait({ id: finished.id })
      const page = yield* jobs.getMany([pending.id, "missing_id", finished.id, pending.id])
      expect(page.size).toBe(2)
      expect(page.get(pending.id)).toMatchObject({ status: "running", generation: pending.generation })
      expect(page.get(finished.id)).toMatchObject({ status: "completed", output: "ready" })
      expect(page.has("missing_id")).toBe(false)
      // Returned projections never expose the mutable registry metadata object.
      page.get(pending.id)!.metadata!.owner = "mutated snapshot"
      expect((yield* jobs.get(pending.id))?.metadata?.owner).toBe("worker")
      yield* jobs.cancel(pending.id)
    }).pipe(Effect.provide(jobsLayer)),
  )
})
