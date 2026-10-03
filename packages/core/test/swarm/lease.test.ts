import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable } from "@opencode-ai/core/swarm/sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-lease-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_lease")
const sessionA = SessionV2.ID.make("ses_swarm_lease_a")
const sessionB = SessionV2.ID.make("ses_swarm_lease_b")
const sessionC = SessionV2.ID.make("ses_swarm_lease_c")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/lease"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm lease", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(sessionA), sessionRow(sessionB), sessionRow(sessionC)])
    .run()
    .pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/lease",
    name: "lease swarm",
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

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/lease",
    title: id,
    version: "test",
  }
}

describe("Swarm lease authority", () => {
  it.effect("permits exactly one winner under concurrent claims", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "claim once", now: 100 })

      const attempts = yield* Effect.all(
        Array.from({ length: 16 }, (_, index) =>
          service
            .claimTask({
              swarmID: swarm.id,
              taskID: task.id,
              memberID: a.id,
              processOwner: "owner-" + index,
              leaseMs: 60_000,
              now: 110,
            })
            .pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      const successes = attempts.filter(Exit.isSuccess)
      expect(successes).toHaveLength(1)
      expect(attempts.filter(Exit.isFailure)).toHaveLength(15)
      expect((yield* service.get(swarm.id)).tasks.find((item) => item.id === task.id)?.status).toBe("working")
    }),
  )

  it.effect("treats expiry as retirement input, never as authority transfer", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b, db } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "expiry fence", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "worker-a",
        leaseMs: 10,
        now: 110,
      })

      expect((yield* service.expiredLeases({ now: 121 })).map((item) => item.taskID)).toEqual([task.id])
      const secondClaim = yield* service
        .claimTask({
          swarmID: swarm.id,
          taskID: task.id,
          memberID: b.id,
          processOwner: "worker-b",
          leaseMs: 60_000,
          now: 121,
        })
        .pipe(Effect.flip)
      expect(secondClaim._tag).toBe("Swarm.InvalidTransitionError")
      expect((yield* db.select().from(SwarmTaskLeaseTable).all().pipe(Effect.orDie))).toHaveLength(1)

      const retiring = yield* service.requestTaskRetirement({
        token: claimed.token,
        reason: "lease_owner_lost",
        now: 122,
      })
      expect(retiring.state).toBe("retiring")
      const settled = yield* service.settleTask({
        token: claimed.token,
        settlement: { type: "superseded", detail: "expired owner retired" },
        now: 123,
      })
      expect(settled.task.status).toBe("ready")
      expect(settled.task.leaseGeneration).toBe(claimed.token.generation + 1)
      expect((yield* db.select().from(SwarmTaskLeaseTable).all().pipe(Effect.orDie))).toHaveLength(0)
    }),
  )

  it.effect("blocks stale completion after rebind but lets the retiring safety fence renew and supersede", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "rebind fence", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "worker-a",
        leaseMs: 100,
        now: 110,
      })
      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: a.id,
        expectedBindingGeneration: claimed.token.bindingGeneration,
        sessionID: sessionC,
        now: 120,
      })

      const staleCompletion = yield* service
        .settleTask({
          token: claimed.token,
          settlement: { type: "completed" },
          now: 121,
        })
        .pipe(Effect.flip)
      expect(staleCompletion._tag).toBe("Swarm.StaleFenceError")

      const retiring = yield* service.requestTaskRetirement({
        token: claimed.token,
        reason: "member_rebind",
        now: 122,
      })
      expect(retiring.state).toBe("retiring")
      const renewed = yield* service.renewTaskLease({
        token: claimed.token,
        leaseMs: 1_000,
        now: 123,
      })
      expect(renewed.state).toBe("retiring")
      const superseded = yield* service.settleTask({
        token: claimed.token,
        settlement: { type: "superseded" },
        now: 124,
      })
      expect(superseded.task.status).toBe("ready")
    }),
  )

  it.effect("separates operational recovery from semantic retry accounting and fences task runs", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "retry taxonomy", now: 100 })
      const first = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "worker-a",
        leaseMs: 1_000,
        now: 110,
      })
      const run = yield* service.recordTaskRun({
        token: first.token,
        sessionInputID: "msg_swarm_run_1" as never,
        now: 111,
      })
      const running = yield* service.startTaskRun({ token: first.token, runID: run.id, now: 112 })
      expect(running.status).toBe("running")
      const providerFailure = yield* service.settleTask({
        token: first.token,
        runID: run.id,
        settlement: { type: "failed", failureKind: "provider", detail: "transient" },
        now: 113,
      })
      expect(providerFailure.task.status).toBe("ready")
      expect(providerFailure.task.semanticRetryCount).toBe(0)
      expect(providerFailure.run?.status).toBe("failed")

      const second = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "worker-a",
        leaseMs: 1_000,
        now: 120,
      })
      const staleLease = yield* service
        .renewTaskLease({ token: first.token, leaseMs: 1_000, now: 120 })
        .pipe(Effect.flip)
      expect(staleLease._tag).toBe("Swarm.StaleFenceError")
      const semanticFailure = yield* service.settleTask({
        token: second.token,
        settlement: { type: "failed", failureKind: "semantic", detail: "wrong result" },
        now: 121,
      })
      expect(semanticFailure.task.status).toBe("failed")
      expect(semanticFailure.task.semanticRetryCount).toBe(1)
    }),
  )

  it.effect("persists a successful result on the exact TaskRun and refuses lossy no-run summaries", () =>
    Effect.gen(function* () {
      const { service, swarm, a, db } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "durable successful result", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "result-worker",
        leaseMs: 1_000,
        now: 110,
      })
      const run = yield* service.recordTaskRun({
        token: claimed.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_result_summary"),
        now: 111,
      })
      yield* service.startTaskRun({ token: claimed.token, runID: run.id, now: 112 })

      const settled = yield* service.settleTask({
        token: claimed.token,
        runID: run.id,
        settlement: { type: "completed", summary: "  verified durable result  " },
        now: 113,
      })
      expect(settled.task.status).toBe("completed")
      expect(settled.run?.status).toBe("completed")
      expect(settled.run?.resultSummary).toBe("verified durable result")
      const persisted = yield* db
        .select({ resultSummary: SwarmTaskRunTable.result_summary })
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, run.id))
        .get()
        .pipe(Effect.orDie)
      expect(persisted?.resultSummary).toBe("verified durable result")

      const noRunTask = yield* service.createTask({ swarmID: swarm.id, title: "no-run summary refusal", now: 120 })
      const noRunLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: noRunTask.id,
        memberID: a.id,
        processOwner: "result-worker",
        leaseMs: 1_000,
        now: 121,
      })
      const refused = yield* service
        .settleTask({
          token: noRunLease.token,
          settlement: { type: "completed", summary: "this would otherwise be dropped" },
          now: 122,
        })
        .pipe(Effect.flip)
      expect(refused._tag).toBe("Swarm.ValidationError")
      expect((yield* service.get(swarm.id)).tasks.find((item) => item.id === noRunTask.id)?.status).toBe("working")

      // Backward-compatible no-run completion stays legal only when there is no
      // result payload to lose.
      const legacy = yield* service.settleTask({
        token: noRunLease.token,
        settlement: { type: "completed" },
        now: 123,
      })
      expect(legacy.task.status).toBe("completed")
    }),
  )

  it.effect("normalizes whitespace-only successful summaries to durable absence", () =>
    Effect.gen(function* () {
      const { service, swarm, a, db } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "empty successful result", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "result-worker",
        leaseMs: 1_000,
        now: 110,
      })
      const run = yield* service.recordTaskRun({
        token: claimed.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_empty_result_summary"),
        now: 111,
      })
      yield* service.startTaskRun({ token: claimed.token, runID: run.id, now: 112 })
      const settled = yield* service.settleTask({
        token: claimed.token,
        runID: run.id,
        settlement: { type: "completed", summary: "   \n\t  " },
        now: 113,
      })
      expect(settled.run?.resultSummary).toBeUndefined()
      const persisted = yield* db
        .select({ resultSummary: SwarmTaskRunTable.result_summary })
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, run.id))
        .get()
        .pipe(Effect.orDie)
      expect(persisted?.resultSummary).toBeNull()
    }),
  )

  it.effect("commits assignment SessionInput and task-run admission atomically, rolling both back on stale binding", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b, db } = yield* setup
      const events = yield* EventV2.Service
      const task = yield* service.createTask({ swarmID: swarm.id, title: "atomic assignment", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "assignment-worker",
        leaseMs: 1_000,
        now: 110,
      })
      const runID = Swarm.TaskRunID.make("swrn_atomic_assignment")
      const inputID = SessionMessage.ID.make("msg_swarm_atomic_assignment")
      const origin = {
        producer: SessionTurnProvenance.Source.SwarmAssignment,
        actor: { type: "host" as const },
        ref: runID,
      }

      const admitted = yield* SessionInput.admitSynthetic(db, events, {
        id: inputID,
        sessionID: sessionA,
        content: { text: "Do the atomic assignment." },
        origin,
        admissionClass: "host",
        delivery: "queue",
        expectedLatestUserSeq: undefined,
        commit: () =>
          SwarmV2.commitTaskRunAdmission(db, {
            token: claimed.token,
            id: runID,
            sessionInputID: inputID,
            admittedAt: 111,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      })
      expect(admitted.id).toBe(inputID)
      expect((yield* SessionInput.findEntry(db, inputID))?.kind).toBe("synthetic")
      const run = yield* db.select().from(SwarmTaskRunTable).where(eq(SwarmTaskRunTable.id, runID)).get().pipe(Effect.orDie)
      expect(run?.status).toBe("admitted")
      expect(run?.session_input_id).toBe(inputID)

      const staleTask = yield* service.createTask({ swarmID: swarm.id, title: "stale assignment", now: 120 })
      const staleClaim = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: staleTask.id,
        memberID: b.id,
        processOwner: "assignment-worker",
        leaseMs: 1_000,
        now: 121,
      })
      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: b.id,
        expectedBindingGeneration: staleClaim.token.bindingGeneration,
        sessionID: sessionC,
        now: 122,
      })
      const staleRunID = Swarm.TaskRunID.make("swrn_stale_assignment")
      const staleInputID = SessionMessage.ID.make("msg_swarm_stale_assignment")
      const staleAdmission = yield* SessionInput.admitSynthetic(db, events, {
        id: staleInputID,
        sessionID: sessionB,
        content: { text: "This must roll back." },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmAssignment,
          actor: { type: "host" as const },
          ref: staleRunID,
        },
        admissionClass: "host",
        delivery: "queue",
        expectedLatestUserSeq: undefined,
        commit: () =>
          SwarmV2.commitTaskRunAdmission(db, {
            token: staleClaim.token,
            id: staleRunID,
            sessionInputID: staleInputID,
            admittedAt: 123,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(staleAdmission)).toBe(true)
      expect(yield* SessionInput.findEntry(db, staleInputID)).toBeUndefined()
      expect(
        yield* db.select().from(SwarmTaskRunTable).where(eq(SwarmTaskRunTable.id, staleRunID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, staleInputID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("projects admitted assignment to running only when Session promotion actually commits", () =>
    Effect.gen(function* () {
      const { service, swarm, a, db } = yield* setup
      const events = yield* EventV2.Service
      const task = yield* service.createTask({ swarmID: swarm.id, title: "promotion-owned start", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "promotion-worker",
        leaseMs: 10_000,
        now: 101,
      })
      const runID = Swarm.TaskRunID.make("swrn_promotion_owned")
      const inputID = SessionMessage.ID.make("msg_swarm_promotion_owned")
      yield* SessionInput.admitSynthetic(db, events, {
        id: inputID,
        sessionID: sessionA,
        content: { text: "assignment" },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmAssignment,
          actor: { type: "host" as const },
          ref: runID,
        },
        admissionClass: "host",
        delivery: "queue",
        userPreemptible: true,
        expectedLatestUserSeq: undefined,
        commit: () =>
          SwarmV2.commitTaskRunAdmission(db, {
            token: claimed.token,
            id: runID,
            sessionInputID: inputID,
            admittedAt: 102,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      })
      const admitted = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(admitted?.status).toBe("admitted")
      expect(admitted?.started_at).toBeNull()

      const promoted = yield* SessionInput.promoteLane(
        db,
        events,
        sessionA,
        { admissionClass: "host", delivery: "queue" },
        Number.MAX_SAFE_INTEGER,
      )
      expect(promoted).toEqual({ selected: 1, promoted: 1, staleRevoked: 0 })
      const running = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(running?.status).toBe("running")
      expect(running?.started_at).not.toBeNull()
      expect((yield* SessionInput.findEntry(db, inputID))?.promotedSeq).toBeDefined()
    }),
  )

  it.effect("direct User admission atomically supersedes an unpromoted assignment and frees its lease without semantic retry", () =>
    Effect.gen(function* () {
      const { service, swarm, a, db } = yield* setup
      const events = yield* EventV2.Service
      const task = yield* service.createTask({ swarmID: swarm.id, title: "yield to human", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "human-focus-worker",
        leaseMs: 10_000,
        now: 101,
      })
      const runID = Swarm.TaskRunID.make("swrn_human_focus")
      const inputID = SessionMessage.ID.make("msg_swarm_human_focus")
      yield* SessionInput.admitSynthetic(db, events, {
        id: inputID,
        sessionID: sessionA,
        content: { text: "pending assignment" },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmAssignment,
          actor: { type: "host" as const },
          ref: runID,
        },
        admissionClass: "host",
        delivery: "queue",
        userPreemptible: true,
        expectedLatestUserSeq: undefined,
        commit: () =>
          SwarmV2.commitTaskRunAdmission(db, {
            token: claimed.token,
            id: runID,
            sessionInputID: inputID,
            admittedAt: 102,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      })

      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make("msg_direct_user_takeover"),
        sessionID: sessionA,
        prompt: Prompt.make({ text: "I am taking over this member chat." }),
        delivery: "queue",
        provenance: { owner: "user", source: SessionTurnProvenance.Source.Prompt },
      })

      const entry = yield* SessionInput.findEntry(db, inputID)
      expect(entry?.revokedReason).toBe("user_superseded")
      expect(entry?.promotedSeq).toBeUndefined()
      const run = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(run?.status).toBe("superseded")
      expect(run?.ended_at).not.toBeNull()
      expect(
        yield* db
          .select()
          .from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.task_id, task.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      const current = (yield* service.get(swarm.id)).tasks.find((item) => item.id === task.id)
      expect(current?.status).toBe("ready")
      expect(current?.semanticRetryCount).toBe(0)
      expect(current?.leaseGeneration).toBe(claimed.token.generation + 1)
    }),
  )

  it.effect("permits only one live task lease per member and backing Session under concurrent task claims", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const first = yield* service.createTask({ swarmID: swarm.id, title: "member capacity a", now: 100 })
      const second = yield* service.createTask({ swarmID: swarm.id, title: "member capacity b", now: 101 })
      const claims = yield* Effect.all(
        [first, second].map((task, index) =>
          service.claimTask({
            swarmID: swarm.id,
            taskID: task.id,
            memberID: a.id,
            processOwner: `capacity-${index}`,
            leaseMs: 1_000,
            now: 110,
          }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(claims.filter(Exit.isSuccess)).toHaveLength(1)
      expect(claims.filter(Exit.isFailure)).toHaveLength(1)
      const failure = claims.find(Exit.isFailure)
      expect(failure && Exit.isFailure(failure) ? failure.cause.toString() : "").toContain("already owns task")
    }),
  )

  it.effect("propagates terminal dependency policy atomically into dependent readiness", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup

      const failedPrerequisite = yield* service.createTask({
        swarmID: swarm.id,
        title: "failed prerequisite",
        now: 100,
      })
      const requiresSuccess = yield* service.createTask({
        swarmID: swarm.id,
        title: "requires success",
        dependencies: [{ taskID: failedPrerequisite.id, requirement: "require_success" }],
        now: 101,
      })
      const requiresTerminal = yield* service.createTask({
        swarmID: swarm.id,
        title: "requires terminal",
        dependencies: [{ taskID: failedPrerequisite.id, requirement: "require_terminal" }],
        now: 102,
      })
      expect(requiresSuccess.status).toBe("blocked")
      expect(requiresTerminal.status).toBe("blocked")

      const failedLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: failedPrerequisite.id,
        memberID: a.id,
        processOwner: "dependency-worker",
        leaseMs: 1_000,
        now: 110,
      })
      yield* service.settleTask({
        token: failedLease.token,
        settlement: { type: "failed", failureKind: "semantic", detail: "semantic failure" },
        now: 111,
      })
      const afterFailure = yield* service.get(swarm.id)
      expect(afterFailure.tasks.find((task) => task.id === requiresSuccess.id)?.status).toBe("blocked")
      expect(afterFailure.tasks.find((task) => task.id === requiresTerminal.id)?.status).toBe("ready")

      const completedPrerequisite = yield* service.createTask({
        swarmID: swarm.id,
        title: "completed prerequisite",
        now: 120,
      })
      const successAfterCompletion = yield* service.createTask({
        swarmID: swarm.id,
        title: "success after completion",
        dependencies: [{ taskID: completedPrerequisite.id, requirement: "require_success" }],
        now: 121,
      })
      const terminalAfterCompletion = yield* service.createTask({
        swarmID: swarm.id,
        title: "terminal after completion",
        dependencies: [{ taskID: completedPrerequisite.id, requirement: "require_terminal" }],
        now: 122,
      })
      const completedLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: completedPrerequisite.id,
        memberID: a.id,
        processOwner: "dependency-worker",
        leaseMs: 1_000,
        now: 130,
      })
      yield* service.settleTask({ token: completedLease.token, settlement: { type: "completed" }, now: 131 })
      const afterCompletion = yield* service.get(swarm.id)
      expect(afterCompletion.tasks.find((task) => task.id === successAfterCompletion.id)?.status).toBe("ready")
      expect(afterCompletion.tasks.find((task) => task.id === terminalAfterCompletion.id)?.status).toBe("ready")
    }),
  )
})
