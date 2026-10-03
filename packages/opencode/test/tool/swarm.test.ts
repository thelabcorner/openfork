import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { SessionInput } from "@opencode-ai/core/session/input"
import { EventV2 } from "@opencode-ai/core/event"
import { TaskRunID } from "@opencode-ai/schema/swarm"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { ToolRegistry } from "@/tool/registry"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Database.node,
      EventV2.node,
      SwarmV2.node,
      SwarmMemberSessionWake.node,
    ]),
  ),
)

const profile = {
  agent: Agent.ID.make("build"),
  model: {
    providerID: Provider.ID.make("test"),
    id: Model.ID.make("test-model"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

function context(sessionID: SessionID, asks: string[]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_swarm_tool"),
    callID: "call_swarm_tool",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request.permission)
      }),
  }
}

const toolAndServices = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const swarms = yield* SwarmV2.Service
  const { db } = yield* Database.Service
  const instance = yield* requireInstance
  const events = yield* EventV2.Service
  const all = yield* registry.all()
  const tool = all.find((item) => item.id === "swarm")
  const createTool = all.find((item) => item.id === "swarm_create")
  if (!tool) return yield* Effect.die("swarm tool not registered")
  if (!createTool) return yield* Effect.die("swarm_create tool not registered")
  return { tool, createTool, registry, swarms, db, events, instance }
})

function sessionRow(id: SessionID, projectID: ProjectV2.ID, directory: string): typeof SessionTable.$inferInsert {
  return {
    id,
    project_id: projectID,
    slug: id,
    directory,
    title: id,
    version: "test",
  }
}

describe("tool.swarm", () => {
  it.instance("is lazy and enforces the swarm.read leaf on project-scoped inspection", () =>
    Effect.gen(function* () {
      const { tool } = yield* toolAndServices
      const asks: string[] = []
      expect(tool.exposure).toBe("lazy")
      const result = yield* tool.execute({ action: "list" }, context(SessionID.make("ses_swarm_list"), asks))
      expect(asks).toEqual(["swarm.read"])
      expect(result.metadata).toMatchObject({ action: "list", permission: "swarm.read", count: 0 })
    }),
  )

  it.instance("creates a Swarm and initial DAG in one direct provider call without broker ceremony", () =>
    Effect.gen(function* () {
      const { createTool, swarms, db, instance } = yield* toolAndServices
      const coordinatorSession = SessionID.make("ses_swarm_create_direct")
      yield* db
        .insert(SessionTable)
        .values(sessionRow(coordinatorSession, instance.project.id, instance.directory))
        .run()
        .pipe(Effect.orDie)

      const asks: string[] = []
      const created = yield* createTool.execute(
        {
          name: "direct native swarm",
          coordinatorName: "lead",
          tasks: [
            { key: "a", title: "First" },
            { key: "b", title: "Second", dependsOn: [{ key: "a", requirement: "require_success" }] },
          ],
        },
        context(coordinatorSession, asks),
      )

      expect(asks).toEqual(["swarm.member"])
      expect(created.metadata).toMatchObject({
        action: "create",
        permission: "swarm.member",
        managedMemberCount: 0,
        taskCount: 2,
        status: "active",
      })

      const detail = yield* swarms.get(SwarmV2.ID.make(created.metadata.swarmId))
      expect(detail.swarm).toMatchObject({ name: "direct native swarm", status: "active", revision: 1 })
      expect(detail.members).toHaveLength(1)
      expect(detail.members[0]).toMatchObject({
        id: detail.swarm.coordinatorMemberID,
        name: "lead",
        kind: "coordinator",
        sessionID: coordinatorSession,
      })
      expect(detail.tasks.map((task) => [task.title, task.status])).toEqual([
        ["First", "ready"],
        ["Second", "blocked"],
      ])
    }),
  )

  it.instance("direct creation rejects an ineligible coordinator before any durable Swarm write", () =>
    Effect.gen(function* () {
      const { createTool, swarms, db, instance } = yield* toolAndServices
      const producerSession = SessionID.make("ses_swarm_create_producer")
      yield* db
        .insert(SessionTable)
        .values({
          ...sessionRow(producerSession, instance.project.id, instance.directory),
          metadata: { scheduledTaskID: "stk_swarm_create" },
        })
        .run()
        .pipe(Effect.orDie)

      const exit = yield* createTool.execute({ name: "must not persist" }, context(producerSession, [])).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("producer-owned")
      expect(yield* swarms.list({ projectID: instance.project.id })).toEqual([])
    }),
  )

  it.instance("delegates fail-closed and derives coordinator authority from the caller Session", () =>
    Effect.gen(function* () {
      const { tool, swarms, db, instance } = yield* toolAndServices
      const coordinatorSession = SessionID.make("ses_swarm_tool_coordinator")
      const peerSession = SessionID.make("ses_swarm_tool_peer")
      yield* Effect.forEach(
        [coordinatorSession, peerSession],
        (id) =>
          db
            .insert(SessionTable)
            .values(sessionRow(id, instance.project.id, instance.directory))
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )

      const asks: string[] = []
      const delegated = yield* tool.execute(
        { action: "delegate", swarmName: "tool-native swarm", coordinatorName: "lead" },
        context(coordinatorSession, asks),
      )
      expect(asks).toEqual(["swarm.member"])
      expect(delegated.metadata.status).toBe("active")
      const id = SwarmV2.ID.make(delegated.metadata.swarmId!)
      const detail = yield* swarms.get(id)
      expect(detail.swarm).toMatchObject({ name: "tool-native swarm", status: "active", revision: 1 })
      expect(detail.members).toHaveLength(1)
      expect(detail.members[0]).toMatchObject({
        id: detail.swarm.coordinatorMemberID,
        name: "lead",
        kind: "coordinator",
        sessionID: coordinatorSession,
      })

      yield* swarms.addMember({
        swarmID: id,
        name: "peer",
        kind: "external",
        role: "observer",
        sessionID: peerSession,
        workspacePolicy: { mode: "shared-read" },
      })
      const denied = yield* tool
        .execute({ action: "state", swarmId: id, status: "paused" }, context(peerSession, []))
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("recorded coordinator")
      expect((yield* swarms.get(id)).swarm.status).toBe("active")
    }),
  )

  it.instance("settles only exact Session-owned running work and routes bounded recovery through the wake seam", () =>
    Effect.gen(function* () {
      const { tool, registry, swarms, db, instance } = yield* toolAndServices
      const coordinatorSession = SessionID.make("ses_swarm_tool_owner")
      const workerSession = SessionID.make("ses_swarm_tool_worker")
      yield* Effect.forEach(
        [coordinatorSession, workerSession],
        (id) =>
          db
            .insert(SessionTable)
            .values(sessionRow(id, instance.project.id, instance.directory))
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )

      const created = yield* swarms.create({
        projectID: instance.project.id,
        directory: instance.directory,
        name: "authority swarm",
      })
      const coordinator = yield* swarms.addMember({
        swarmID: created.id,
        name: "lead",
        kind: "coordinator",
        role: "coordinate",
        sessionID: coordinatorSession,
        workspacePolicy: { mode: "shared-read" },
      })
      const worker = yield* swarms.addMember({
        swarmID: created.id,
        name: "worker",
        kind: "managed_worker",
        role: "implement",
        sessionID: workerSession,
        desiredProfile: profile,
        workspacePolicy: { mode: "shared-read" },
      })
      yield* swarms.addMember({
        swarmID: created.id,
        name: "unbound",
        kind: "managed_worker",
        role: "recover",
        desiredProfile: profile,
        workspacePolicy: { mode: "shared-read" },
      })
      const active = yield* swarms.update({
        id: created.id,
        expectedRevision: created.revision,
        coordinatorMemberID: coordinator.id,
        status: "active",
      })
      expect(active.status).toBe("active")

      const task = yield* swarms.createTask({
        swarmID: created.id,
        title: "authority task",
        createdByMemberID: coordinator.id,
        reservedMemberID: worker.id,
      })
      const claimed = yield* swarms.claimTask({
        swarmID: created.id,
        taskID: task.id,
        memberID: worker.id,
        processOwner: "tool-test-owner",
        leaseMs: 60_000,
      })
      const run = yield* swarms.recordTaskRun({
        token: claimed.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_tool_assignment"),
      })
      yield* swarms.startTaskRun({ token: claimed.token, runID: run.id })

      const injectedAuthority = yield* tool
        .execute(
          { action: "task.settle", swarmId: created.id, taskId: task.id, settlement: "completed" },
          context(workerSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(injectedAuthority)).toBe(true)
      expect((yield* swarms.get(created.id)).tasks.find((item) => item.id === task.id)?.status).toBe("working")

      const asks: string[] = []
      const providerTools = yield* registry.tools({
        providerID: Provider.ID.make("test"),
        modelID: Model.ID.make("test-model"),
        agent: { name: "build", mode: "primary", permission: [], options: {} },
      })
      expect(providerTools.map((item) => item.id)).toContain("tool")
      expect(providerTools.map((item) => item.id)).not.toContain("swarm")
      const broker = providerTools.find((item) => item.id === "tool")!
      const descriptor = JSON.parse(
        (yield* broker.execute({ action: "describe", tool: "swarm" }, context(workerSession, asks))).output,
      )
      expect(descriptor.description).toContain("task.settle: swarmId, settlement; when settlement=failed also require failureKind")
      expect(descriptor.description).toContain("omit taskId and member identity")
      expect(descriptor.description).toContain("resultSummary")
      expect(descriptor.description).toContain("message.send: swarmId, body, and either targetMemberId or broadcast=true")
      const settled = yield* broker.execute(
        {
          action: "call",
          tool: "swarm",
          contract: descriptor.contract,
          args: {
            action: "task.settle",
            swarmId: created.id,
            settlement: "completed",
            resultSummary: "verified through lazy fallback",
          },
        },
        context(workerSession, asks),
      )
      expect(asks).toEqual(["swarm.task"])
      expect(settled.metadata).toMatchObject({ delegatedTool: "swarm", action: "task.settle" })
      expect(settled.metadata).toMatchObject({ taskId: task.id, memberId: worker.id, status: "completed" })
      expect((yield* swarms.get(created.id)).tasks.find((item) => item.id === task.id)?.status).toBe("completed")
      const history = yield* swarms.taskRunHistory({ swarmID: created.id, taskID: task.id, limit: 1 })
      expect(history.items[0]?.resultSummary).toBe("verified through lazy fallback")

      const runAsks: string[] = []
      const audited = yield* broker.execute(
        {
          action: "call",
          tool: "swarm",
          contract: descriptor.contract,
          args: { action: "task.runs", swarmId: created.id, taskId: task.id, limit: 1 },
        },
        context(coordinatorSession, runAsks),
      )
      expect(runAsks).toEqual(["swarm.read"])
      expect(audited.metadata).toMatchObject({
        delegatedTool: "swarm",
        action: "task.runs",
        swarmId: created.id,
        taskId: task.id,
        count: 1,
      })
      expect(audited.output).toContain("verified through lazy fallback")
      expect(audited.output).toContain(String(worker.id))
      expect(audited.output).toContain(String(run.id))

      // Build one newer run so the native read surface must expose and honor the
      // same (time_created,id) keyset cursor used by Core/HTTP.
      const newerTask = yield* swarms.createTask({
        swarmID: created.id,
        title: "newer audit task",
        createdByMemberID: coordinator.id,
        reservedMemberID: worker.id,
      })
      const newerLease = yield* swarms.claimTask({
        swarmID: created.id,
        taskID: newerTask.id,
        memberID: worker.id,
        processOwner: "tool-test-owner",
        leaseMs: 60_000,
      })
      const newerRun = yield* swarms.recordTaskRun({
        token: newerLease.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_tool_assignment_newer"),
      })
      yield* swarms.startTaskRun({ token: newerLease.token, runID: newerRun.id })
      yield* swarms.settleTask({
        token: newerLease.token,
        runID: newerRun.id,
        settlement: { type: "completed", summary: "newer audit result" },
      })

      const coreFirstPage = yield* swarms.taskRunHistory({ swarmID: created.id, limit: 1 })
      expect(coreFirstPage.items[0]?.id).toBe(newerRun.id)
      expect(coreFirstPage.more).toBe(true)
      expect(coreFirstPage.next).toBeDefined()

      const pageOneAsks: string[] = []
      const pageOne = yield* broker.execute(
        {
          action: "call",
          tool: "swarm",
          contract: descriptor.contract,
          args: { action: "task.runs", swarmId: created.id, limit: 1 },
        },
        context(coordinatorSession, pageOneAsks),
      )
      expect(pageOneAsks).toEqual(["swarm.read"])
      expect(pageOne.output).toContain(String(newerRun.id))
      expect(pageOne.output).toContain('"more": true')
      expect(pageOne.output).toContain('"next"')

      const pageTwoAsks: string[] = []
      const pageTwo = yield* broker.execute(
        {
          action: "call",
          tool: "swarm",
          contract: descriptor.contract,
          args: {
            action: "task.runs",
            swarmId: created.id,
            limit: 1,
            runCursor: coreFirstPage.next!,
          },
        },
        context(coordinatorSession, pageTwoAsks),
      )
      expect(pageTwoAsks).toEqual(["swarm.read"])
      expect(pageTwo.output).toContain(String(run.id))
      expect(pageTwo.output).not.toContain(String(newerRun.id))

      const wake = yield* SwarmMemberSessionWake.Service
      let requested: Swarm.ID | undefined
      const uninstall = yield* wake.install((swarmID) =>
        Effect.sync(() => {
          requested = swarmID
        }),
      )
      const recoveryAsks: string[] = []
      const recovery = yield* tool.execute(
        { action: "recover.members", swarmId: created.id },
        context(coordinatorSession, recoveryAsks),
      )
      yield* uninstall
      expect(recoveryAsks).toEqual(["swarm.member"])
      expect(requested).toBe(created.id)
      expect(recovery.metadata).toMatchObject({ count: 1, status: "requested" })
    }),
  )

  /**
   * Coordinator lifecycle closure: reviewing a review_pending task, listing
   * effect-unknown fences, and explicitly acknowledging containment.
   *
   * Builds a genuine review_pending task through the domain (claim -> admit ->
   * start -> contained_unknown), so the assertions exercise the real fences
   * rather than a hand-written status.
   */
  const reviewFixture = Effect.gen(function* () {
    const { tool, swarms, db, events, instance } = yield* toolAndServices
    const coordinatorSession = SessionID.make("ses_swarm_review_coordinator")
    const workerSession = SessionID.make("ses_swarm_review_worker")
    const peerSession = SessionID.make("ses_swarm_review_peer")
    yield* Effect.forEach(
      [coordinatorSession, workerSession, peerSession],
      (id) =>
        db
          .insert(SessionTable)
          .values(sessionRow(id, instance.project.id, instance.directory))
          .run()
          .pipe(Effect.orDie),
      { discard: true },
    )

    const created = yield* swarms.create({
      projectID: instance.project.id,
      directory: instance.directory,
      name: "review swarm",
      now: 10,
    })
    const info = yield* swarms.update({ id: created.id, expectedRevision: created.revision, status: "active", now: 11 })
    const coordinator = yield* swarms.addMember({
      swarmID: info.id,
      name: "lead",
      kind: "coordinator",
      role: "coordinator",
      sessionID: coordinatorSession,
      workspacePolicy: { mode: "shared-read" },
      now: 12,
    })
    yield* swarms.update({
      id: info.id,
      expectedRevision: (yield* swarms.info(info.id)).revision,
      coordinatorMemberID: coordinator.id,
      now: 13,
    })
    const worker = yield* swarms.addMember({
      swarmID: info.id,
      name: "worker",
      kind: "managed_worker",
      role: "worker",
      desiredProfile: profile,
      sessionID: workerSession,
      workspacePolicy: { mode: "shared-read" },
      now: 14,
    })
    // A real non-coordinator member, so the denial below is specifically about
    // coordinator authority rather than non-membership.
    yield* swarms.addMember({
      swarmID: info.id,
      name: "peer",
      kind: "external",
      role: "observer",
      sessionID: peerSession,
      workspacePolicy: { mode: "shared-read" },
      now: 15,
    })

    const task = yield* swarms.createTask({ swarmID: info.id, title: "needs review", now: 20 })
    const claim = yield* swarms.claimTask({
      swarmID: info.id,
      taskID: task.id,
      memberID: worker.id,
      processOwner: "runtime-owner:swarm-review-tool",
      leaseMs: 60_000,
      now: 21,
    })
    const runID = TaskRunID.create()
    const inputID = SessionMessage.ID.create()
    yield* SessionInput.admitSynthetic(db, events, {
      id: inputID,
      sessionID: workerSession,
      content: { text: "do the work" },
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
          token: claim.token,
          id: runID,
          sessionInputID: inputID,
          admittedAt: 22,
        }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
    })
    yield* swarms.startTaskRun({ token: claim.token, runID, now: 23 })
    return { tool, swarms, coordinatorSession, workerSession, peerSession, info, task, claim, runID, coordinator }
  })

  it.instance("task.review requires the coordinator, the decision, and the observed lease generation", () =>
    Effect.gen(function* () {
      const { tool, swarms, coordinatorSession, peerSession, info, task, claim, runID } = yield* reviewFixture

      // Schema-level: a review without a decision is rejected before any
      // permission ask or Swarm mutation, naming the action and the fields.
      const missingDecision = yield* tool
        .execute(
          { action: "task.review", swarmId: info.id, taskId: task.id, expectedLeaseGeneration: 1 },
          context(coordinatorSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingDecision)).toBe(true)
      if (Exit.isFailure(missingDecision)) {
        expect(Cause.pretty(missingDecision.cause)).toContain("task.review")
        expect(Cause.pretty(missingDecision.cause)).toContain("decision")
      }

      const missingFence = yield* tool
        .execute(
          { action: "task.review", swarmId: info.id, taskId: task.id, decision: "accept" },
          context(coordinatorSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingFence)).toBe(true)
      if (Exit.isFailure(missingFence)) {
        expect(Cause.pretty(missingFence.cause)).toContain("expectedLeaseGeneration")
      }

      // Coordinator authority: a non-coordinator member cannot review.
      const denied = yield* tool
        .execute(
          {
            action: "task.review",
            swarmId: info.id,
            taskId: task.id,
            decision: "accept",
            expectedLeaseGeneration: 1,
          },
          context(peerSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("recorded coordinator")

      // Park the task in review_pending the way a contained unknown outcome does.
      yield* swarms.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 30 })
      const settled = yield* swarms.settleTask({
        token: claim.token,
        runID,
        settlement: { type: "contained_unknown", detail: "contained by operator" },
        now: 31,
      })
      expect(settled.task.status).toBe("review_pending")
      const parked = settled.task

      // A stale observed generation fails closed instead of reviewing whatever
      // execution happens to be current.
      const stale = yield* tool
        .execute(
          {
            action: "task.review",
            swarmId: info.id,
            taskId: task.id,
            decision: "accept",
            expectedLeaseGeneration: claim.token.generation,
          },
          context(coordinatorSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)

      const asks: string[] = []
      const accepted = yield* tool.execute(
        {
          action: "task.review",
          swarmId: info.id,
          taskId: task.id,
          decision: "accept",
          expectedLeaseGeneration: parked.leaseGeneration,
          detail: "verified by hand",
        },
        context(coordinatorSession, asks),
      )
      expect(asks).toEqual(["swarm.review"])
      expect(accepted.metadata).toMatchObject({ taskId: task.id, status: "completed" })
      expect((yield* swarms.get(info.id)).tasks.find((item) => item.id === task.id)?.status).toBe("completed")
    }),
  )

  it.instance("recover.effects is a coordinator read and recover.contain fails closed without a real fence", () =>
    Effect.gen(function* () {
      const { tool, info, coordinatorSession, peerSession, task, claim } = yield* reviewFixture

      const peerAsks: string[] = []
      const denied = yield* tool
        .execute({ action: "recover.effects", swarmId: info.id }, context(peerSession, peerAsks))
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("recorded coordinator")

      const asks: string[] = []
      const listed = yield* tool.execute(
        { action: "recover.effects", swarmId: info.id },
        context(coordinatorSession, asks),
      )
      expect(asks).toEqual(["swarm.read"])
      expect(listed.metadata).toMatchObject({ count: 0, status: "clear" })
      expect(listed.output).toContain("[SWARM EFFECTS]")

      // Nothing is fenced, so acknowledgement must refuse rather than invent
      // containment. It reports which read to do first.
      const containAsks: string[] = []
      const refused = yield* tool
        .execute(
          {
            action: "recover.contain",
            swarmId: info.id,
            taskId: task.id,
            leaseGeneration: claim.token.generation,
          },
          context(coordinatorSession, containAsks),
        )
        .pipe(Effect.exit)
      expect(containAsks).toEqual(["swarm.review"])
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(Cause.pretty(refused.cause)).toContain("recover.effects")
    }),
  )
})
