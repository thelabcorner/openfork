import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable } from "@opencode-ai/core/swarm/sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-closure-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_closure")
const sessionA = SessionV2.ID.make("ses_swarm_closure_a")
const sessionB = SessionV2.ID.make("ses_swarm_closure_b")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/closure",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/closure"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm closure", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([sessionRow(sessionA), sessionRow(sessionB)]).run().pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/closure",
    name: "closure swarm",
    now: 10,
  })
  const a = yield* service.addMember({
    swarmID: swarm.id,
    name: "a",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: sessionA,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const b = yield* service.addMember({
    swarmID: swarm.id,
    name: "b",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: sessionB,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  return { service, swarm, a, b, db }
})

const leaseFor = (db: Effect.Success<typeof Database.Service>["db"], taskID: string) =>
  db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID as never))
    .get()
    .pipe(Effect.orDie)

const runFor = (db: Effect.Success<typeof Database.Service>["db"], runID: string) =>
  db
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, runID as never))
    .get()
    .pipe(Effect.orDie)

const claimWithRun = (
  state: Effect.Success<typeof setup>,
  input: { title: string; now: number; start: boolean },
) =>
  Effect.gen(function* () {
    const task = yield* state.service.createTask({ swarmID: state.swarm.id, title: input.title, now: input.now })
    const claim = yield* state.service.claimTask({
      swarmID: state.swarm.id,
      taskID: task.id,
      memberID: state.a.id,
      processOwner: "closure-owner",
      leaseMs: 600_000,
      now: input.now + 1,
    })
    const run = yield* state.service.recordTaskRun({
      token: claim.token,
      sessionInputID: SessionMessage.ID.make(`msg_closure_${task.id}` as never),
      now: input.now + 2,
    })
    if (input.start)
      yield* state.service.startTaskRun({ token: claim.token, runID: run.id, now: input.now + 3 })
    return { task, claim, run }
  })

describe("Swarm execution-end closure (unsettled)", () => {
  it.effect("closes a running-but-unsettled run into review_pending and releases exact lease authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const started = yield* claimWithRun(state, { title: "no settlement", now: 100, start: true })

      const closed = yield* state.service.settleTask({
        token: started.claim.token,
        runID: started.run.id,
        settlement: { type: "unsettled", detail: "execution ended without settlement" },
        now: 110,
      })

      expect(closed.task.status).toBe("review_pending")
      expect(closed.task.semanticRetryCount).toBe(0)
      expect(closed.task.leaseGeneration).toBe(started.claim.token.generation + 1)
      expect(closed.task.readyAt).toBeUndefined()
      expect(closed.run?.status).toBe("unsettled")
      expect(closed.run?.endedAt).toBeDefined()
      expect(closed.run?.failureKind).toBeUndefined()

      expect(yield* leaseFor(state.db, started.task.id)).toBeUndefined()
      expect(yield* runFor(state.db, started.run.id)).toMatchObject({ status: "unsettled" })

      // Anti-replay: the task must not become dispatchable again.
      const ready = yield* state.service.readyAssignments({ now: 200 })
      expect(ready.map((assignment) => assignment.task.id)).not.toContain(started.task.id)
      // Released lease authority cannot be replayed by the old owner.
      expect(
        yield* state.service
          .settleTask({
            token: started.claim.token,
            runID: started.run.id,
            settlement: { type: "unsettled" },
          })
          .pipe(Effect.flip)
          .pipe(Effect.map((error) => error._tag)),
      ).toBe("Swarm.NotFoundError")
    }),
  )

  it.effect("refuses to close an admitted run as unsettled because execution never began", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const admitted = yield* claimWithRun(state, { title: "never started", now: 100, start: false })
      expect(yield* runFor(state.db, admitted.run.id)).toMatchObject({ status: "admitted" })

      const error = yield* state.service
        .settleTask({
          token: admitted.claim.token,
          runID: admitted.run.id,
          settlement: { type: "unsettled" },
          now: 110,
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Swarm.ConflictError")

      // Rejection is total: no partial closure of task, run, or lease.
      expect(yield* leaseFor(state.db, admitted.task.id)).toMatchObject({ state: "active" })
      expect(yield* runFor(state.db, admitted.run.id)).toMatchObject({ status: "admitted" })
      expect(yield* state.service.get(state.swarm.id).pipe(Effect.map((detail) =>
        detail.tasks.find((task) => task.id === admitted.task.id)?.status,
      ))).toBe("working")
    }),
  )

  it.effect("leaves retirement as the sole owner of a retiring lease", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const started = yield* claimWithRun(state, { title: "retiring wins", now: 100, start: true })
      yield* state.service.requestTaskRetirement({
        token: started.claim.token,
        reason: "operator_release",
        now: 105,
      })

      const error = yield* state.service
        .settleTask({
          token: started.claim.token,
          runID: started.run.id,
          settlement: { type: "unsettled" },
          now: 110,
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Swarm.ConflictError")
      if (error._tag === "Swarm.ConflictError") expect(error.code).toBe("swarm.retirement_owns_closure")

      expect(yield* leaseFor(state.db, started.task.id)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state.db, started.run.id)).toMatchObject({ status: "running" })
    }),
  )

  it.effect("does not let leading non-running leases starve a real running candidate", () =>
    Effect.gen(function* () {
      const state = yield* setup
      // Task one is claimed and admitted but never started, so it must not
      // consume the candidate bound ahead of the running candidate.
      const admitted = yield* claimWithRun(state, { title: "leading admitted", now: 100, start: false })
      const running = yield* Effect.gen(function* () {
        const task = yield* state.service.createTask({ swarmID: state.swarm.id, title: "later running", now: 200 })
        const claim = yield* state.service.claimTask({
          swarmID: state.swarm.id,
          taskID: task.id,
          memberID: state.b.id,
          processOwner: "closure-owner-b",
          leaseMs: 600_000,
          now: 201,
        })
        const run = yield* state.service.recordTaskRun({
          token: claim.token,
          sessionInputID: SessionMessage.ID.make("msg_closure_later" as never),
          now: 202,
        })
        yield* state.service.startTaskRun({ token: claim.token, runID: run.id, now: 203 })
        return { task, claim, run }
      })

      const targets = yield* state.service.unsettledExecutionTargets({ limit: 1 })
      expect(targets.map((target) => target.token.taskID)).toEqual([running.task.id])
      expect(targets[0]?.run.id).toBe(running.run.id)
      expect(targets.map((target) => target.token.taskID)).not.toContain(admitted.task.id)
    }),
  )
})