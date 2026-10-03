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
})
