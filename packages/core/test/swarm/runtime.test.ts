import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmMessageDeliveryTable } from "@opencode-ai/core/swarm/sql"
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

const projectID = ProjectV2.ID.make("swarm-runtime-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_runtime")
const sessionA = SessionV2.ID.make("ses_swarm_runtime_a")
const sessionB = SessionV2.ID.make("ses_swarm_runtime_b")
const sessionC = SessionV2.ID.make("ses_swarm_runtime_c")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/runtime",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/runtime"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm runtime", project_id: projectID, time_used: 1 })
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
    directory: "/swarm/runtime",
    name: "runtime swarm",
    now: 10,
  })
  yield* service.update({
    id: swarm.id,
    expectedRevision: swarm.revision,
    status: "active",
    now: 15,
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
  return { db, service, swarm, a, b }
})

describe("Swarm runtime projections", () => {
  it.effect("returns exact process-owned renewal and expiry tokens", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "runtime lease", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "runtime-owner-a",
        leaseMs: 1_000,
        now: 110,
      })

      expect(
        yield* service.leaseRenewalTargets({
          processOwner: "runtime-owner-a",
          now: 500,
          renewBefore: 1_200,
        }),
      ).toMatchObject([{ token: claimed.token }])
      expect(
        yield* service.leaseRenewalTargets({
          processOwner: "other-owner",
          now: 500,
          renewBefore: 1_200,
        }),
      ).toEqual([])
      expect(yield* service.expiredLeaseTargets({ now: 1_109 })).toEqual([])
      expect(yield* service.expiredLeaseTargets({ now: 1_110 })).toMatchObject([{ token: claimed.token }])
    }),
  )

  it.effect("resolves member task settlement authority only from one active running Session lease", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const task = yield* service.createTask({ swarmID: swarm.id, title: "authoritative run", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "runtime-owner-a",
        leaseMs: 10_000,
        now: 110,
      })
      const runID = Swarm.TaskRunID.make("swrn_runtime_authority")
      const run = yield* service.recordTaskRun({
        token: claimed.token,
        id: runID,
        sessionInputID: SessionMessage.ID.make("msg_swarm_runtime_authority"),
        admittedAt: 111,
        now: 111,
      })

      expect(
        (
          yield* service
            .sessionTaskAuthority({ swarmID: swarm.id, sessionID: sessionA })
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")

      yield* service.startTaskRun({ token: claimed.token, runID: run.id, now: 112 })
      expect(yield* service.sessionTaskAuthority({ swarmID: swarm.id, sessionID: sessionA })).toMatchObject({
        token: claimed.token,
        member: { id: a.id, sessionID: sessionA, bindingGeneration: a.bindingGeneration },
        task: { id: task.id, status: "working" },
        run: { id: run.id, status: "running", leaseGeneration: claimed.token.generation },
      })

      yield* service.holdTask({ token: claimed.token, userSeq: 7, deadline: 1_000, now: 120 })
      expect(
        (
          yield* service
            .sessionTaskAuthority({ swarmID: swarm.id, sessionID: sessionA })
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")

      yield* service.resumeHeldTask({ token: claimed.token, now: 130 })
      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: a.id,
        expectedBindingGeneration: a.bindingGeneration,
        sessionID: sessionC,
        now: 140,
      })
      expect(
        (
          yield* service
            .sessionTaskAuthority({ swarmID: swarm.id, sessionID: sessionA })
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")
      expect(
        (
          yield* service
            .sessionTaskAuthority({ swarmID: swarm.id, sessionID: sessionC })
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")
    }),
  )

  it.effect("projects due human holds and chooses the earliest reconstructible deadline", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, b } = yield* setup
      const heldTask = yield* service.createTask({ swarmID: swarm.id, title: "held", now: 100 })
      const held = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: heldTask.id,
        memberID: a.id,
        processOwner: "runtime-owner-a",
        leaseMs: 10_000,
        now: 110,
      })
      yield* service.holdTask({ token: held.token, userSeq: 7, deadline: 800, now: 120 })

      const reserved = yield* service.createTask({
        swarmID: swarm.id,
        title: "reserved",
        reservedMemberID: b.id,
        reservedUntil: 700,
        now: 130,
      })
      expect(reserved.status).toBe("ready")

      const sent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "deadline",
        expiresAt: 650,
        now: 140,
      })
      yield* db
        .update(SwarmMessageDeliveryTable)
        .set({ next_attempt_at: 600 })
        .where(eq(SwarmMessageDeliveryTable.id, sent.deliveries[0]!.id))
        .run()
        .pipe(Effect.orDie)

      expect(
        yield* service.nextRuntimeDeadline({
          now: 500,
          processOwner: "runtime-owner-a",
          leaseRenewAheadMs: 1_000,
        }),
      ).toEqual({ at: 600, hasRetiring: false, dispatchDue: false })
      expect(yield* service.dueHoldTargets({ now: 799 })).toEqual([])
      expect(yield* service.dueHoldTargets({ now: 800 })).toMatchObject([{ token: held.token }])
    }),
  )

  it.effect("projects retiring run and SessionInput state without N+1 hydration", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a } = yield* setup
      const events = yield* EventV2.Service
      const task = yield* service.createTask({ swarmID: swarm.id, title: "retiring", now: 100 })
      const claimed = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: a.id,
        processOwner: "runtime-owner-a",
        leaseMs: 10_000,
        now: 110,
      })
      const runID = Swarm.TaskRunID.make("swrn_runtime_retirement")
      const inputID = SessionMessage.ID.make("msg_swarm_runtime_retirement")
      yield* SessionInput.admitSynthetic(db, events, {
        id: inputID,
        sessionID: sessionA,
        content: { text: "retirement projection" },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmAssignment,
          actor: { type: "host" },
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
            admittedAt: 111,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      })
      yield* service.requestTaskRetirement({ token: claimed.token, reason: "operator_release", now: 112 })
      expect(
        yield* service.nextRuntimeDeadline({
          now: 200,
          processOwner: "other-owner",
          leaseRenewAheadMs: 1_000,
        }),
      ).toEqual({ hasRetiring: true, dispatchDue: false })

      const [target] = yield* service.retiringTargets()
      expect(target?.token).toEqual(claimed.token)
      expect(target?.runs).toHaveLength(1)
      expect(target?.runs[0]).toMatchObject({
        run: { id: runID, status: "admitted", sessionInputID: inputID },
        input: { id: inputID },
      })
      expect(target?.runs[0]?.input?.promotedSeq).toBeUndefined()
      expect(target?.runs[0]?.input?.revokedSeq).toBeUndefined()
    }),
  )

  it.effect("detects rebind and member-stop leases as retirement-required with exact fences", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b } = yield* setup
      const rebindTask = yield* service.createTask({ swarmID: swarm.id, title: "rebind", now: 100 })
      const reboundLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: rebindTask.id,
        memberID: a.id,
        processOwner: "runtime-owner-a",
        leaseMs: 10_000,
        now: 110,
      })
      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: a.id,
        expectedBindingGeneration: a.bindingGeneration,
        sessionID: sessionC,
        now: 120,
      })

      const stopTask = yield* service.createTask({ swarmID: swarm.id, title: "stop", now: 130 })
      const stoppedLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: stopTask.id,
        memberID: b.id,
        processOwner: "runtime-owner-b",
        leaseMs: 10_000,
        now: 140,
      })
      yield* service.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: b.id,
        expectedLifecycle: "active",
        lifecycle: "stopped",
        now: 150,
      })

      const required = yield* service.retirementRequiredTargets()
      expect(required).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ token: reboundLease.token, reason: "member_rebind" }),
          expect.objectContaining({ token: stoppedLease.token, reason: "member_stop" }),
        ]),
      )
    }),
  )

  it.effect("projects bounded active/held scheduler owners without treating retiring fences as recoverable", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b } = yield* setup
      const deadTask = yield* service.createTask({ swarmID: swarm.id, title: "dead owner", now: 100 })
      const deadLease = yield* service.claimTask({
        swarmID: swarm.id,
        taskID: deadTask.id,
        memberID: a.id,
        processOwner: "runtime-owner-dead",
        leaseMs: 10_000,
        now: 110,
      })
      const currentTask = yield* service.createTask({ swarmID: swarm.id, title: "current owner", now: 120 })
      yield* service.claimTask({
        swarmID: swarm.id,
        taskID: currentTask.id,
        memberID: b.id,
        processOwner: "runtime-owner-current",
        leaseMs: 10_000,
        now: 130,
      })

      expect(
        yield* service.activeLeaseOwnerProcessIDs({
          excludeProcessOwner: "runtime-owner-current",
          limit: 16,
        }),
      ).toEqual(["runtime-owner-dead"])
      expect(
        yield* service.activeLeaseOwnerProcessIDs({
          afterProcessOwner: "runtime-owner-current",
          limit: 16,
        }),
      ).toEqual(["runtime-owner-dead"])
      expect(yield* service.processLeaseTargets({ processOwner: "runtime-owner-dead", limit: 16 })).toMatchObject([
        { token: deadLease.token, lease: { state: "active" } },
      ])

      yield* service.requestTaskRetirement({
        token: deadLease.token,
        reason: "lease_owner_lost",
        now: 140,
      })
      expect(
        yield* service.activeLeaseOwnerProcessIDs({
          excludeProcessOwner: "runtime-owner-current",
          limit: 16,
        }),
      ).toEqual([])
      expect(yield* service.processLeaseTargets({ processOwner: "runtime-owner-dead", limit: 16 })).toEqual([])
    }),
  )
})
