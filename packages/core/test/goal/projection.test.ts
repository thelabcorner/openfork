import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GoalV2 } from "@opencode-ai/core/goal"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { GoalProjection } from "@opencode-ai/core/goal/projection"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { makeRunnerHistoryProjection } from "@opencode-ai/core/session/runner/history-projection"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      GoalV2.node,
      GoalContext.node,
      GoalProjection.node,
    ]),
  ),
)

const sessionID = SessionSchema.ID.make("ses_goal_projection")
const directory = AbsolutePath.make("/goal/projection")

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory,
      title: "Goal projection",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return database
})

const createFocused = Effect.gen(function* () {
  const goals = yield* GoalV2.Service
  const detail = yield* goals.create({
    projectID: Project.ID.global,
    title: "Ship projection semantics",
    objective: "Keep mutable Goal state out of privileged System context.",
    constraints: ["Do not scan transcript history"],
    criteria: ["Projection is durable"],
    steps: [{ title: "Implement", description: "Publish semantic snapshots" }],
    continuationPolicy: { mode: "auto_continue", maxConsecutiveTurns: 4, maxNoProgressTurns: 2 },
  })
  yield* goals.focus({ goalID: detail.goal.id, sessionID })
  return detail
})

describe("GoalProjection", () => {
  it.effect("keeps only stable Goal mechanism policy in privileged System and removes it on unfocus", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const context = yield* GoalContext.Service
      yield* createFocused

      const focused = yield* SystemContext.observeSurface(yield* context.forSession(sessionID))
      expect(focused.observations).toEqual([
        SystemSurface.present(SystemSurface.Key.make("goal/mechanism"), GoalContext.MECHANISM_POLICY),
      ])
      const privileged = focused.observations[0]?.type === "present" ? focused.observations[0].rendered : ""
      expect(privileged).toContain("<goal_mechanism>")
      expect(privileged).not.toContain("Ship projection semantics")
      expect(privileged).not.toContain("Keep mutable Goal state out of privileged System context")
      expect(privileged).not.toContain("Do not scan transcript history")
      expect(privileged).not.toContain('<goal_progress state="current"')

      yield* goals.unfocus({ sessionID })
      const unfocused = yield* SystemContext.observeSurface(yield* context.forSession(sessionID))
      expect(unfocused.observations).toEqual([
        SystemSurface.absent(SystemSurface.Key.make("goal/mechanism"), "required"),
      ])
      expect(yield* context.render(sessionID)).toBeUndefined()
    }),
  )

  it.effect("splits stable specification bytes from independently changing progress bytes", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const detail = yield* createFocused
      const initial = GoalProjection.sections(detail)
      const spec = initial.find((item) => item.kind === "spec")!
      const progress = initial.find((item) => item.kind === "progress")!

      expect(spec.text).toContain("Ship projection semantics")
      expect(spec.text).toContain("Do not scan transcript history")
      expect(spec.text).toContain("Projection is durable")
      expect(spec.text).toContain("Publish semantic snapshots")
      expect(spec.text).not.toContain("status=\"draft\"")
      expect(progress.text).toContain("<status>draft</status>")
      expect(progress.text).not.toContain("Keep mutable Goal state out of privileged System context")
      expect(progress.text).not.toContain("Do not scan transcript history")

      const updated = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: detail.goal.revision,
        objective: "Use two independently fingerprinted semantic sections.",
      })
      const afterSpec = GoalProjection.sections(updated)
      expect(afterSpec.find((item) => item.kind === "spec")!.digest).not.toBe(spec.digest)
      expect(afterSpec.find((item) => item.kind === "progress")!.digest).toBe(progress.digest)

      const policyOnly = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: updated.goal.revision,
        auditorPolicy: { blockedThreshold: 2, maxAttempts: 2 },
      })
      const afterUnrelatedRevision = GoalProjection.sections(policyOnly)
      expect(afterUnrelatedRevision.map((item) => item.digest)).toEqual(afterSpec.map((item) => item.digest))
    }),
  )

  it.effect("publishes durable state idempotently and republishes the same meaning once after compaction", () =>
    Effect.gen(function* () {
      const { readDb } = yield* setup
      const events = yield* EventV2.Service
      const goals = yield* GoalV2.Service
      const projection = yield* GoalProjection.Service
      const detail = yield* createFocused
      const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })
      const reconcile = Effect.fnUntraced(function* () {
        return yield* projection.reconcile({ sessionID, effective: yield* history.stateProjections(-1) })
      })

      expect((yield* reconcile()).published).toBe(2)
      let state = yield* history.stateProjections(-1)
      const initialSpec = state.messages.get(SessionTurnProvenance.Source.GoalSpecification)!
      const initialProgress = state.messages.get(SessionTurnProvenance.Source.GoalProgress)!
      expect(initialSpec.type).toBe("synthetic")
      expect(initialSpec.provenance).toMatchObject({ owner: "host", source: "goal.spec" })
      expect(initialProgress.provenance).toMatchObject({ owner: "host", source: "goal.progress" })
      expect((yield* reconcile()).published).toBe(0)

      const specUpdate = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: detail.goal.revision,
        title: "Ship independent projection semantics",
      })
      expect((yield* reconcile()).published).toBe(1)
      state = yield* history.stateProjections(-1)
      expect(state.messages.get(SessionTurnProvenance.Source.GoalSpecification)!.id).not.toBe(initialSpec.id)
      expect(state.messages.get(SessionTurnProvenance.Source.GoalProgress)!.id).toBe(initialProgress.id)

      const unrelated = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: specUpdate.goal.revision,
        auditorPolicy: { blockedThreshold: 3 },
      })
      expect((yield* reconcile()).published).toBe(0)

      // Publication identity is a per-kind deterministic hash chain rather than
      // only (semantic digest + compaction epoch). That makes recurrence
      // representable without churning unchanged state: A -> B -> A publishes a
      // second A after B, while retries of either transition converge.
      const beforeRecurrence = yield* goals.get(detail.goal.id)
      const stateA = GoalProjection.sections(beforeRecurrence).find((item) => item.kind === "spec")!
      const stateBDetail = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: beforeRecurrence.goal.revision,
        title: "Temporary projection title",
      })
      expect((yield* reconcile()).published).toBe(1)
      const stateBMessage = (yield* history.stateProjections(-1)).messages.get(
        SessionTurnProvenance.Source.GoalSpecification,
      )!
      const stateB = GoalProjection.sections(stateBDetail).find((item) => item.kind === "spec")!
      expect(stateB.digest).not.toBe(stateA.digest)
      const stateAReturn = yield* goals.update({
        id: detail.goal.id,
        expectedRevision: stateBDetail.goal.revision,
        title: beforeRecurrence.goal.title,
      })
      expect(GoalProjection.sections(stateAReturn).find((item) => item.kind === "spec")!.digest).toBe(stateA.digest)
      expect((yield* reconcile()).published).toBe(1)
      const recurrentA = (yield* history.stateProjections(-1)).messages.get(
        SessionTurnProvenance.Source.GoalSpecification,
      )!
      expect(recurrentA.id).not.toBe(initialSpec.id)
      expect(recurrentA.id).not.toBe(stateBMessage.id)
      expect((yield* reconcile()).published).toBe(0)

      const staleEffective = yield* history.stateProjections(-1)
      yield* goals.transition({ id: detail.goal.id, expectedRevision: stateAReturn.goal.revision, action: "start" })
      expect((yield* projection.reconcile({ sessionID, effective: staleEffective })).published).toBe(1)
      // Simulate retry after durable publication but before the caller refreshed
      // its in-memory view. Exact deterministic identity must converge on the
      // already-persisted row instead of appending another projection.
      expect((yield* projection.reconcile({ sessionID, effective: staleEffective })).published).toBe(0)

      state = yield* history.stateProjections(-1)
      const beforeCompaction = new Map(state.messages)
      const compactionID = SessionMessage.ID.make("msg_goal_projection_compaction")
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(100),
        reason: "manual",
        text: "summary without mutable Goal snapshots",
        recent: "recent work",
      })
      state = yield* history.stateProjections(-1)
      expect(state.resetBoundary).toBe(compactionID)
      expect(state.messages.size).toBe(0)
      expect((yield* reconcile()).published).toBe(2)
      expect((yield* reconcile()).published).toBe(0)
      state = yield* history.stateProjections(-1)
      expect(state.messages.get(SessionTurnProvenance.Source.GoalSpecification)!.id).not.toBe(
        beforeCompaction.get(SessionTurnProvenance.Source.GoalSpecification)!.id,
      )
      expect(state.messages.get(SessionTurnProvenance.Source.GoalProgress)!.id).not.toBe(
        beforeCompaction.get(SessionTurnProvenance.Source.GoalProgress)!.id,
      )

      yield* goals.unfocus({ sessionID })
      expect((yield* reconcile()).published).toBe(2)
      state = yield* history.stateProjections(-1)
      expect(state.messages.get(SessionTurnProvenance.Source.GoalSpecification)!.text).toContain('state="none"')
      expect(state.messages.get(SessionTurnProvenance.Source.GoalProgress)!.text).toContain('state="none"')
      expect((yield* reconcile()).published).toBe(0)
      yield* history.close

      // Restart/replay reconstructs the same effective meaning entirely from
      // durable rows; no projection-side owner table is required.
      const restarted = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })
      const replayed = yield* restarted.stateProjections(-1)
      expect(replayed.resetBoundary).toBe(compactionID)
      expect(replayed.messages.get(SessionTurnProvenance.Source.GoalSpecification)?.text).toContain('state="none"')
      expect(replayed.messages.get(SessionTurnProvenance.Source.GoalProgress)?.text).toContain('state="none"')
      expect(
        (yield* projection.reconcile({ sessionID, effective: replayed })).published,
      ).toBe(0)
      yield* restarted.close
    }),
  )
})
