import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { GoalV2 } from "@opencode-ai/core/goal"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import {
  GoalAutomationTable,
  GoalCriterionTable,
  GoalEvidenceTable,
  GoalFocusTable,
  GoalStepTable,
} from "@opencode-ai/core/goal/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Goal } from "@opencode-ai/schema/goal"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, GoalV2.node, GoalAutomation.node])),
)

const projectA = ProjectV2.ID.make("goal-project-a")
const projectB = ProjectV2.ID.make("goal-project-b")
const workspaceA = WorkspaceV2.ID.make("wrk_goal_a")
const workspaceA2 = WorkspaceV2.ID.make("wrk_goal_a2")
const sessionA = SessionV2.ID.make("ses_goal_a")
const sessionA2 = SessionV2.ID.make("ses_goal_a2")
const sessionOtherWorkspace = SessionV2.ID.make("ses_goal_other_workspace")
const sessionB = SessionV2.ID.make("ses_goal_b")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values([
      { id: projectA, worktree: AbsolutePath.make("/goal/project-a"), sandboxes: [] },
      { id: projectB, worktree: AbsolutePath.make("/goal/project-b"), sandboxes: [] },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values([
      { id: workspaceA, type: "local", name: "A", project_id: projectA, time_used: 1 },
      { id: workspaceA2, type: "local", name: "A2", project_id: projectA, time_used: 1 },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      sessionRow(sessionA, projectA, workspaceA),
      sessionRow(sessionA2, projectA, workspaceA),
      sessionRow(sessionOtherWorkspace, projectA, workspaceA2),
      sessionRow(sessionB, projectB),
    ])
    .run()
    .pipe(Effect.orDie)
})

function sessionRow(id: SessionV2.ID, projectID: ProjectV2.ID, workspaceID?: WorkspaceV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: projectID === projectA ? "/goal/project-a" : "/goal/project-b",
    title: id,
    version: "test",
  }
}

function createGoal(overrides: Partial<GoalV2.CreateInput> = {}) {
  return GoalV2.Service.use((goals) =>
    goals.create({
      projectID: projectA,
      title: "Ship Goal Mode",
      objective: "Implement Goal Mode without a second runner.",
      constraints: ["Preserve existing Session semantics"],
      criteria: ["Goal state persists", "Lifecycle is verified"],
      steps: [{ title: "Foundation", description: "Build the durable Goal domain" }],
      ...overrides,
    }),
  )
}

describe("Goal", () => {
  it.effect("creates durable normalized Goal state and emits a creation event", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === GoalV2.Event.Created.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const created = yield* goals.create({
        projectID: projectA,
        workspaceID: workspaceA,
        title: "  Goal title  ",
        objective: "  Durable objective  ",
        constraints: ["  No runner fork  "],
        criteria: ["  Tests pass  ", " State survives restart "],
        steps: [{ title: "  Foundation  ", description: "  Persist state  " }],
      })

      expect(created.goal).toMatchObject({
        projectID: projectA,
        workspaceID: workspaceA,
        title: "Goal title",
        objective: "Durable objective",
        constraints: ["No runner fork"],
        status: "draft",
        revision: 0,
        continuationPolicy: { mode: "manual" },
      })
      expect(created.criteria.map((item) => item.description)).toEqual(["Tests pass", "State survives restart"])
      expect(created.steps).toHaveLength(1)
      expect((yield* goals.get(created.goal.id)).goal.id).toBe(created.goal.id)
      expect((yield* goals.list({ projectID: projectA })).map((item) => item.id)).toContain(created.goal.id)
      expect(published).toHaveLength(1)
      expect(published[0]?.data).toMatchObject({ goalID: created.goal.id })
      expect((yield* goals.audit(created.goal.id)).map((event) => [event.seq, event.type])).toEqual([[0, "created"]])
    }),
  )

  it.effect("requires acceptance criteria before start and preserves the draft on rejection", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal({ criteria: [] })
      const error = yield* goals
        .transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
        .pipe(Effect.flip)

      expect(error._tag).toBe("Goal.ValidationError")
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({ status: "draft", revision: 0 })
      expect(yield* goals.audit(created.goal.id)).toHaveLength(1)
    }),
  )

  it.effect("uses SQL CAS revisions to reject stale writers", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const updated = yield* goals.update({ id: created.goal.id, expectedRevision: 0, title: "Writer one" })
      expect(updated.goal).toMatchObject({ title: "Writer one", revision: 1 })

      const stale = yield* goals
        .update({ id: created.goal.id, expectedRevision: 0, title: "Writer two" })
        .pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: "Goal.StaleRevisionError",
        goalID: created.goal.id,
        expectedRevision: 0,
        actualRevision: 1,
      })
      expect((yield* goals.get(created.goal.id)).goal.title).toBe("Writer one")
    }),
  )

  it.effect("cannot complete without verification and passed criteria", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      expect(active.goal.status).toBe("active")

      const illegal = yield* goals
        .transition({ id: created.goal.id, expectedRevision: 1, action: "verification_pass" })
        .pipe(Effect.flip)
      expect(illegal._tag).toBe("Goal.InvalidTransitionError")

      const verifying = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: 1,
        action: "request_verification",
      })
      expect(verifying.goal.status).toBe("verifying")
      const incomplete = yield* goals
        .transition({ id: created.goal.id, expectedRevision: 2, action: "verification_pass" })
        .pipe(Effect.flip)
      expect(incomplete._tag).toBe("Goal.ValidationError")
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({ status: "verifying", revision: 2 })

      yield* db
        .update(GoalCriterionTable)
        .set({ status: "passed" })
        .where(eq(GoalCriterionTable.goal_id, created.goal.id))
        .run()
        .pipe(Effect.orDie)

      const noEvidence = yield* goals
        .transition({
          id: created.goal.id,
          expectedRevision: 2,
          action: "verification_pass",
          actor: "system",
        })
        .pipe(Effect.flip)
      expect(noEvidence._tag).toBe("Goal.ValidationError")

      let revision = 2
      for (const criterion of created.criteria) {
        yield* goals.addEvidence({
          goalID: created.goal.id,
          expectedRevision: revision,
          criterionID: criterion.id,
          type: "test",
          summary: `Verified ${criterion.description}`,
          verdict: "passed",
          actor: "system",
        })
        revision++
      }
      const completed = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: revision,
        action: "verification_pass",
        actor: "system",
      })
      expect(completed.goal.status).toBe("completed")
      expect(completed.goal.time.completed).toBeDefined()
      expect(
        (
          yield* goals
            .transition({ id: created.goal.id, expectedRevision: completed.goal.revision, action: "cancel" })
            .pipe(Effect.flip)
        )._tag,
      ).toBe("Goal.InvalidTransitionError")
    }),
  )

  it.effect("blocks with an explicit reason, resumes cleanly, and retains cancellation history", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      const noReason = yield* goals
        .transition({ id: created.goal.id, expectedRevision: active.goal.revision, action: "block" })
        .pipe(Effect.flip)
      expect(noReason._tag).toBe("Goal.ValidationError")

      const blocked = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: active.goal.revision,
        action: "block",
        blocker: "Need a user decision",
      })
      expect(blocked.goal).toMatchObject({ status: "blocked", blocker: "Need a user decision" })
      const resumed = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: blocked.goal.revision,
        action: "resume",
      })
      expect(resumed.goal).toMatchObject({ status: "active", blocker: undefined })

      yield* db
        .insert(GoalEvidenceTable)
        .values({
          id: Goal.EvidenceID.create(),
          goal_id: created.goal.id,
          type: "test",
          summary: "Evidence before cancellation",
        })
        .run()
        .pipe(Effect.orDie)
      const cancelled = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: resumed.goal.revision,
        action: "cancel",
      })
      expect(cancelled.goal.status).toBe("cancelled")
      expect(cancelled.criteria).toHaveLength(2)
      expect(
        yield* db.select().from(GoalEvidenceTable).where(eq(GoalEvidenceTable.goal_id, created.goal.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
      expect((yield* goals.audit(created.goal.id)).map((event) => event.type)).toEqual([
        "created",
        "transitioned",
        "transitioned",
        "transitioned",
        "transitioned",
      ])
    }),
  )

  it.effect("enforces one focused Goal per Session while allowing one Goal across Sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const first = yield* createGoal({ title: "First" })
      const second = yield* createGoal({ title: "Second" })

      yield* goals.focus({ goalID: first.goal.id, sessionID: sessionA })
      yield* goals.focus({ goalID: first.goal.id, sessionID: sessionA2, role: "worker" })
      expect((yield* goals.focuses(first.goal.id)).map((focus) => focus.sessionID)).toEqual([sessionA, sessionA2])

      yield* goals.focus({ goalID: second.goal.id, sessionID: sessionA })
      expect((yield* goals.focused(sessionA))?.detail.goal.id).toBe(second.goal.id)
      expect((yield* goals.focuses(first.goal.id)).map((focus) => focus.sessionID)).toEqual([sessionA2])
      expect((yield* goals.audit(first.goal.id)).map((event) => event.type)).toContain("unfocused")
    }),
  )

  it.effect("rejects cross-project and cross-workspace focus bindings", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const projectGoal = yield* createGoal()
      const workspaceGoal = yield* createGoal({ workspaceID: workspaceA })

      const crossProject = yield* goals.focus({ goalID: projectGoal.goal.id, sessionID: sessionB }).pipe(Effect.flip)
      expect(crossProject._tag).toBe("Goal.ValidationError")
      const crossWorkspace = yield* goals
        .focus({ goalID: workspaceGoal.goal.id, sessionID: sessionOtherWorkspace })
        .pipe(Effect.flip)
      expect(crossWorkspace._tag).toBe("Goal.ValidationError")
    }),
  )

  it.effect("survives Session deletion while focus is cleaned and step assignment is nulled", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const step = created.steps[0]!
      yield* db
        .update(GoalStepTable)
        .set({ assigned_session_id: sessionA })
        .where(eq(GoalStepTable.id, step.id))
        .run()
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: created.goal.id, sessionID: sessionA })

      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionA)).run().pipe(Effect.orDie)

      expect(yield* goals.focused(sessionA)).toBeUndefined()
      expect(yield* db.select().from(GoalFocusTable).where(eq(GoalFocusTable.session_id, sessionA)).get().pipe(Effect.orDie)).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).steps[0]?.assignedSessionID).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).goal.id).toBe(created.goal.id)
    }),
  )
})

describe("Goal automation reservations", () => {
  it.effect("claims each continuation exactly once and can release it for recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal({ continuationPolicy: { mode: "auto_continue" } })
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({ sessionID: sessionA, origin: "user", tokens: 120 })
      expect(decision.continue).toBe(true)
      expect(decision.reservation?.id).toBeString()

      const first = yield* automation.claim(sessionA)
      expect(first?.id).toBe(decision.reservation?.id)
      expect(yield* automation.claim(sessionA)).toBeUndefined()

      yield* automation.release({ sessionID: sessionA, reservationID: first!.id })
      expect(yield* automation.pendingSessions()).toContain(sessionA)
      expect((yield* automation.claim(sessionA))?.id).toBe(first?.id)
    }),
  )

  it.effect("user supersession deletes a claimed reservation so stale output cannot recreate it", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal({ continuationPolicy: { mode: "unattended" } })
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      yield* automation.afterTurn({ sessionID: sessionA, origin: "user" })
      const claimed = yield* automation.claim(sessionA)
      expect(claimed).toBeDefined()

      yield* automation.cancel(sessionA)
      const stale = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "automatic",
        reservationID: claimed!.id,
      })
      expect(stale).toMatchObject({ continue: false, reason: "reservation_superseded" })
      expect(
        yield* db.select().from(GoalAutomationTable).where(eq(GoalAutomationTable.session_id, sessionA)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("blocks the Goal when an automatic cycle makes no revision progress past its guardrail", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal({
        continuationPolicy: { mode: "auto_continue", maxNoProgressTurns: 1, maxConsecutiveTurns: 8 },
      })
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      const first = yield* automation.afterTurn({ sessionID: sessionA, origin: "user" })
      const claimed = yield* automation.claim(sessionA)
      expect(first.reservation?.id).toBe(claimed?.id)

      const stopped = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "automatic",
        reservationID: claimed!.id,
      })
      expect(stopped.continue).toBe(false)
      expect(stopped.reason).toContain("guardrail:no Goal-state progress")
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({
        status: "blocked",
        blocker: "Automation guardrail: no Goal-state progress for 1 automatic turns",
      })
    }),
  )
})
