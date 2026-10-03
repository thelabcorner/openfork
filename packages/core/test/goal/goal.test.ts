import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { GoalV2 } from "@opencode-ai/core/goal"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
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
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, GoalV2.node, GoalAutomation.node, GoalAgent.node]),
  ),
)

const projectA = ProjectV2.ID.make("goal-project-a")
const projectB = ProjectV2.ID.make("goal-project-b")
const workspaceA = WorkspaceV2.ID.make("wrk_goal_a")
const workspaceA2 = WorkspaceV2.ID.make("wrk_goal_a2")
const sessionA = SessionV2.ID.make("ses_goal_a")
const sessionA2 = SessionV2.ID.make("ses_goal_a2")
const sessionOtherWorkspace = SessionV2.ID.make("ses_goal_other_workspace")
const sessionB = SessionV2.ID.make("ses_goal_b")

const continueAudit = (criteria: ReadonlyArray<Goal.Criterion>, progressMade = false): GoalAutomation.AuditOutcome => ({
  ok: true,
  verdict: {
    decision: "continue",
    rationale: "Concrete Goal work remains.",
    progressMade,
    criteria: criteria.map((criterion) => ({
      criterionID: criterion.id,
      status: "pending",
      evidence: "This acceptance criterion is not yet independently verified.",
    })),
    continuationPrompt: "Continue with the next concrete Goal task and verify it with evidence.",
  },
})

const blockedAudit = (
  criteria: ReadonlyArray<Goal.Criterion>,
  blocker = "A required external decision is unavailable",
): GoalAutomation.AuditOutcome => ({
  ok: true,
  verdict: {
    decision: "blocked",
    rationale: blocker,
    blocker,
    progressMade: false,
    criteria: criteria.map((criterion) => ({
      criterionID: criterion.id,
      status: "pending",
      evidence: "The suspected blocker prevents independent verification.",
    })),
  },
})

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
  it.effect("lets the agent create, focus, and start a Goal only from an authorized user turn", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const goals = yield* GoalV2.Service

      const result = yield* agent.execute(
        sessionA,
        {
          action: "create",
          objective: "Ship agent-assisted Goal setup.",
          criteria: ["The Goal is created from the user's request", "The Goal is focused and active"],
          constraints: ["Do not replace an unrelated focused Goal"],
          steps: [{ title: "Implement", description: "Add the trusted creation path" }],
        },
        {
          userMessageID: "msg_goal_agent_create",
          userText: "Please create a goal for agent-assisted Goal setup and start it.",
        },
      )

      expect(result.goal.goal.projectID).toBe(projectA)
      expect(result.goal.goal.workspaceID).toBe(workspaceA)
      expect(result.goal.goal.status).toBe("active")
      expect(result.goal.criteria).toHaveLength(2)
      expect((yield* goals.focused(sessionA))?.focus.role).toBe("owner")
      const created = (yield* goals.audit(result.goal.goal.id)).find((item) => item.type === "created")
      expect(created?.actor).toBe("agent")
      expect(created?.payload.sourceMessageID).toBe("msg_goal_agent_create")
    }),
  )

  it.effect("rejects agent-initiated Goal creation without explicit user authorization", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const exit = yield* agent
        .execute(
          sessionA,
          { action: "create", objective: "Invent a Goal", criteria: ["Something happens"] },
          { userMessageID: "msg_normal", userText: "Please fix the failing test." },
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* (yield* GoalV2.Service).focused(sessionA)).toBeUndefined()
    }),
  )

  it.effect("accepts a user confirmation after the agent proposes creating a Goal", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const result = yield* agent.execute(
        sessionA,
        { action: "create", objective: "Stabilize the release", criteria: ["Release checks pass"] },
        {
          userMessageID: "msg_yes",
          userText: "Yes, go ahead.",
          previousAssistantText: "This is multi-step work. Should I create a Goal for the release and start it?",
        },
      )
      expect(result.goal.goal.status).toBe("active")
    }),
  )

  it.effect("reserves auditor_verification evidence for host-owned independent reconciliation", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({
        id: created.goal.id,
        expectedRevision: created.goal.revision,
        action: "start",
      })

      const forged = yield* goals
        .addEvidence({
          goalID: active.goal.id,
          expectedRevision: active.goal.revision,
          criterionID: active.criteria[0]!.id,
          type: "auditor_verification",
          summary: "worker-authored text must never become independent verification",
          verdict: "passed",
          actor: "agent",
        })
        .pipe(Effect.flip)

      expect(forged._tag).toBe("Goal.ValidationError")
      if (forged._tag === "Goal.ValidationError") expect(forged.reason).toContain("host-owned evidence")
      expect(yield* goals.evidence(active.goal.id)).toHaveLength(0)
    }),
  )

  it.effect("lets an explicit user directive strengthen an active Goal without replacing progress or evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const goals = yield* GoalV2.Service
      const created = yield* agent.execute(
        sessionA,
        {
          action: "create",
          objective: "Render documents with deterministic visual parity.",
          constraints: ["Keep rendering deterministic"],
          criteria: ["Baseline rendering parity is verified"],
          steps: [{ title: "Baseline", description: "Verify the baseline corpus" }],
        },
        { userMessageID: "msg_goal_visual_create", userText: "Create a goal for visual rendering parity." },
      )

      const originalCriterion = created.goal.criteria[0]!
      const originalStep = created.goal.steps[0]!
      const evidence = yield* goals.addEvidence({
        goalID: created.goal.goal.id,
        expectedRevision: created.goal.goal.revision,
        criterionID: originalCriterion.id,
        type: "visual-regression",
        summary: "Baseline corpus matched.",
        verdict: "passed",
        actor: "agent",
      })
      const afterEvidence = yield* goals.get(created.goal.goal.id)
      const passed = yield* goals.updateCriterion({
        goalID: created.goal.goal.id,
        criterionID: originalCriterion.id,
        expectedRevision: afterEvidence.goal.revision,
        status: "passed",
        actor: "agent",
      })

      const updated = yield* agent.execute(
        sessionA,
        {
          action: "update",
          expectedRevision: passed.goal.revision,
          constraints: ["Keep rendering deterministic", "Exercise multiple independent stress corpuses"],
          criteria: [
            "Baseline rendering parity is verified",
            "Stress-test corpuses cover difficult rendering combinations",
            "Rendered output maintains 1:1 bitmap parity",
          ],
          steps: [
            { title: "Baseline", description: "Verify the baseline corpus" },
            { title: "Stress corpuses", description: "Run broad adversarial visual corpuses" },
          ],
        },
        {
          userMessageID: "msg_goal_visual_update",
          userText:
            "Update the goal and make sure you are doing a bunch of stress-test-corpuses and ensuring 1:1 bitmap parity.",
        },
      )

      expect(updated.goal.criteria.map((item) => item.description)).toEqual([
        "Baseline rendering parity is verified",
        "Stress-test corpuses cover difficult rendering combinations",
        "Rendered output maintains 1:1 bitmap parity",
      ])
      expect(updated.goal.criteria[0]).toMatchObject({ id: originalCriterion.id, status: "passed" })
      expect(updated.goal.steps[0]).toMatchObject({ id: originalStep.id, title: "Baseline" })
      expect(updated.goal.goal.constraints).toEqual([
        "Keep rendering deterministic",
        "Exercise multiple independent stress corpuses",
      ])
      expect((yield* goals.evidence(updated.goal.goal.id)).find((item) => item.id === evidence.id)).toMatchObject({
        criterionID: originalCriterion.id,
      })

      const audit = (yield* goals.audit(updated.goal.goal.id))
        .filter((item) => item.type === "specification_updated")
        .at(-1)
      expect(audit).toMatchObject({
        actor: "agent",
        payload: {
          mode: "amend",
          sourceMessageID: "msg_goal_visual_update",
          addedConstraints: 1,
          addedCriteria: 2,
          addedSteps: 1,
        },
      })

      const retry = yield* agent.execute(
        sessionA,
        {
          action: "update",
          expectedRevision: updated.goal.goal.revision,
          constraints: ["Exercise multiple independent stress corpuses"],
          criteria: ["Rendered output maintains 1:1 bitmap parity"],
          steps: [{ title: "Stress corpuses", description: "Run broad adversarial visual corpuses" }],
        },
        { userMessageID: "msg_goal_visual_update", userText: "Update the goal with those exact requirements." },
      )
      expect(retry.goal.goal.revision).toBe(updated.goal.goal.revision)
      expect(retry.goal.criteria.map((item) => item.id)).toEqual(updated.goal.criteria.map((item) => item.id))
      expect(retry.goal.steps.map((item) => item.id)).toEqual(updated.goal.steps.map((item) => item.id))
    }),
  )

  it.effect("rejects agent Goal specification edits without a current explicit human update directive", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const created = yield* agent.execute(
        sessionA,
        { action: "create", objective: "Keep the release stable", criteria: ["Release remains stable"] },
        { userMessageID: "msg_goal_stable_create", userText: "Create a goal for release stability." },
      )
      const exit = yield* agent
        .execute(
          sessionA,
          { action: "update", criteria: ["Agent-invented acceptance criterion"] },
          {
            userMessageID: "msg_goal_stable_continue",
            userText: "Continue with the implementation.",
            priorUserTurns: [{ userMessageID: "msg_old_update", userText: "Update the goal if needed." }],
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        (yield* (yield* GoalV2.Service).get(created.goal.goal.id)).criteria.map((item) => item.description),
      ).toEqual(["Release remains stable"])
    }),
  )

  it.effect("creates from an earlier unrevoked user Goal request and preserves that request as provenance", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const goals = yield* GoalV2.Service
      const result = yield* agent.execute(
        sessionA,
        { action: "create", objective: "Finish the historical-request refactor", criteria: ["Refactor is complete"] },
        {
          userMessageID: "msg_neutral_followup",
          userText: "Continue.",
          priorUserTurns: [
            {
              userMessageID: "msg_historical_goal_request",
              userText: "Set a Goal for this refactor and keep working until it is done.",
            },
          ],
        },
      )

      expect(result.goal.goal.status).toBe("active")
      const created = (yield* goals.audit(result.goal.goal.id)).find((item) => item.type === "created")
      expect(created?.payload.sourceMessageID).toBe("msg_historical_goal_request")
    }),
  )

  it.effect("keeps an agent-created Goal as a draft when the user explicitly says not to start it", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* (yield* GoalAgent.Service).execute(
        sessionA,
        {
          action: "create",
          objective: "Prepare the migration plan",
          criteria: ["The migration plan is complete"],
          // Even a mistaken model-supplied true cannot override the user's no-start instruction.
          start: true,
        },
        {
          userMessageID: "msg_goal_draft",
          userText: "Create a Goal draft for the migration plan, but don't start it yet.",
        },
      )
      expect(result.goal.goal.status).toBe("draft")
      expect((yield* (yield* GoalV2.Service).focused(sessionA))?.detail.goal.id).toBe(result.goal.goal.id)
    }),
  )

  it.effect("does not replace a different focused Goal implicitly and keeps same-objective creation idempotent", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* GoalAgent.Service
      const provenance = {
        userMessageID: "msg_goal_retry",
        userText: "Create a goal for shipping the release.",
      }
      const first = yield* agent.execute(
        sessionA,
        { action: "create", objective: "Ship the release", criteria: ["Release shipped"] },
        provenance,
      )
      const retry = yield* agent.execute(
        sessionA,
        { action: "create", objective: "Ship the release", criteria: ["Release shipped"] },
        provenance,
      )
      expect(retry.goal.goal.id).toBe(first.goal.goal.id)

      const rejected = yield* agent
        .execute(
          sessionA,
          { action: "create", objective: "Different Goal", criteria: ["Different work complete"] },
          { userMessageID: "msg_goal_different", userText: "Create a goal for different work." },
        )
        .pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect((yield* (yield* GoalV2.Service).focused(sessionA))?.detail.goal.id).toBe(first.goal.goal.id)
    }),
  )

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
        (yield* goals
          .transition({ id: created.goal.id, expectedRevision: completed.goal.revision, action: "cancel" })
          .pipe(Effect.flip))._tag,
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
        yield* db
          .select()
          .from(GoalEvidenceTable)
          .where(eq(GoalEvidenceTable.goal_id, created.goal.id))
          .all()
          .pipe(Effect.orDie),
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

  it.effect("reactivates a focused blocked Goal on genuine user input semantics without touching paused Goals", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      const blocked = yield* goals.transition({
        id: active.goal.id,
        expectedRevision: active.goal.revision,
        action: "block",
        blocker: "Need new user input",
      })

      expect(yield* goals.reactivateBlockedForSession(sessionA)).toBe(true)
      const reopened = yield* goals.get(created.goal.id)
      expect(reopened.goal).toMatchObject({ status: "active", blocker: undefined })
      expect(yield* goals.reactivateBlockedForSession(sessionA)).toBe(false)

      const paused = yield* goals.transition({
        id: reopened.goal.id,
        expectedRevision: reopened.goal.revision,
        action: "pause",
      })
      expect(yield* goals.reactivateBlockedForSession(sessionA)).toBe(false)
      expect((yield* goals.get(created.goal.id)).goal.status).toBe("paused")

      const audit = yield* goals.audit(created.goal.id)
      expect(audit.at(-2)?.payload).toMatchObject({
        from: "blocked",
        to: "active",
        action: "resume",
        source: "user_prompt",
      })
      expect(paused.goal.status).toBe("paused")
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

  it.effect("treats repeated Goal bookkeeping as idempotent instead of fake progress", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      const criterion = active.criteria[0]!
      const step = active.steps[0]!

      const sameCriterion = yield* goals.updateCriterion({
        goalID: active.goal.id,
        criterionID: criterion.id,
        expectedRevision: active.goal.revision,
        status: criterion.status,
        actor: "agent",
      })
      expect(sameCriterion.goal.revision).toBe(active.goal.revision)

      const sameStep = yield* goals.updateStep({
        goalID: active.goal.id,
        stepID: step.id,
        expectedRevision: sameCriterion.goal.revision,
        status: step.status,
        actor: "agent",
      })
      expect(sameStep.goal.revision).toBe(active.goal.revision)

      const claimed = yield* goals.claimStep({
        goalID: active.goal.id,
        stepID: step.id,
        sessionID: sessionA,
        expectedRevision: sameStep.goal.revision,
        actor: "agent",
      })
      const released = yield* goals.releaseStep({
        goalID: active.goal.id,
        stepID: step.id,
        sessionID: sessionA,
        expectedRevision: claimed.goal.revision,
        actor: "agent",
      })
      const releaseRetry = yield* goals.releaseStep({
        goalID: active.goal.id,
        stepID: step.id,
        sessionID: sessionA,
        expectedRevision: released.goal.revision,
        actor: "agent",
      })
      expect(releaseRetry.goal.revision).toBe(released.goal.revision)

      const bookkeepingEvents = (yield* goals.audit(active.goal.id)).filter(
        (event) => event.type === "criterion_updated" || event.type === "step_updated",
      )
      // Only the real claim and release transitions are durable bookkeeping.
      expect(bookkeepingEvents).toHaveLength(2)
    }),
  )

  it.effect("optimistic focus fences never overwrite or clear a concurrently changed Session focus", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const first = yield* createGoal({ title: "First" })
      const second = yield* createGoal({ title: "Second" })

      yield* goals.focus({
        goalID: first.goal.id,
        sessionID: sessionA,
        expectedCurrentGoalID: null,
      })
      expect((yield* goals.focused(sessionA))?.detail.goal.id).toBe(first.goal.id)

      const staleVacant = yield* goals
        .focus({
          goalID: second.goal.id,
          sessionID: sessionA,
          expectedCurrentGoalID: null,
        })
        .pipe(Effect.flip)
      expect(staleVacant).toMatchObject({ _tag: "Goal.ValidationError" })
      expect((yield* goals.focused(sessionA))?.detail.goal.id).toBe(first.goal.id)

      expect(
        yield* goals.unfocusExpected({
          sessionID: sessionA,
          goalID: second.goal.id,
        }),
      ).toBe(false)
      expect((yield* goals.focused(sessionA))?.detail.goal.id).toBe(first.goal.id)

      expect(
        yield* goals.unfocusExpected({
          sessionID: sessionA,
          goalID: first.goal.id,
        }),
      ).toBe(true)
      expect(yield* goals.focused(sessionA)).toBeUndefined()

      yield* goals.focus({
        goalID: second.goal.id,
        sessionID: sessionA,
        expectedCurrentGoalID: null,
      })
      const staleExpected = yield* goals
        .focus({
          goalID: first.goal.id,
          sessionID: sessionA,
          expectedCurrentGoalID: first.goal.id,
        })
        .pipe(Effect.flip)
      expect(staleExpected).toMatchObject({ _tag: "Goal.ValidationError" })
      expect((yield* goals.focused(sessionA))?.detail.goal.id).toBe(second.goal.id)
    }),
  )

  it.effect("rejects every protected special-agent Session from Goal focus roles", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const kinds = ["goal_auditor", "goal_revisor", "prompt_revisor", "session_title", "spad_auditor"] as const

      for (const [index, kind] of kinds.entries()) {
        const id = SessionV2.ID.make(`ses_goal_special_${index}`)
        yield* db
          .insert(SessionTable)
          .values({
            ...sessionRow(id, projectA, workspaceA),
            parent_id: sessionA,
            metadata: {
              specialAgent: kind,
              specialAgentOwnerKind: "session",
              specialAgentOwnerID: sessionA,
            },
          })
          .run()
          .pipe(Effect.orDie)

        for (const role of ["owner", "worker", "verifier"] as const) {
          const error = yield* goals.focus({ goalID: created.goal.id, sessionID: id, role }).pipe(Effect.flip)
          expect(error._tag).toBe("Goal.ValidationError")
          if (error._tag === "Goal.ValidationError") expect(error.reason).toContain("Special-agent Sessions")
        }
      }
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
      expect(
        yield* db.select().from(GoalFocusTable).where(eq(GoalFocusTable.session_id, sessionA)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).steps[0]?.assignedSessionID).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).goal.id).toBe(created.goal.id)
    }),
  )
})

describe("Goal automation reservations", () => {
  it.effect("audits every focused runnable Goal", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service

      expect(yield* automation.shouldAudit(sessionA)).toBe(false)

      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      expect(yield* automation.shouldAudit(sessionA)).toBe(true)

      const verifying = yield* goals.transition({
        id: active.goal.id,
        expectedRevision: active.goal.revision,
        action: "request_verification",
      })
      expect(yield* automation.shouldAudit(sessionA)).toBe(true)

      const activeAgain = yield* goals.transition({
        id: verifying.goal.id,
        expectedRevision: verifying.goal.revision,
        action: "verification_fail",
      })
      yield* goals.transition({
        id: activeAgain.goal.id,
        expectedRevision: activeAgain.goal.revision,
        action: "block",
        blocker: "test blocker",
      })
      expect(yield* automation.shouldAudit(sessionA)).toBe(false)
    }),
  )

  it.effect("treats an explicit audit request as an immediate Goal Mode audit, not a separate mode", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service

      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      expect(yield* automation.shouldAudit(sessionA)).toBe(true)
      expect(yield* automation.requestAudit(sessionA)).toMatchObject({ phase: "audit_requested" })

      const auditorSessionID = yield* goals.auditorSession({ parentSessionID: sessionA, goalID: active.goal.id })
      expect(yield* automation.beginAudit({ sessionID: sessionA, auditorSessionID })).toMatchObject({
        phase: "auditing",
        auditorSessionID,
      })
      yield* automation.endAudit(sessionA)

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: continueAudit(active.criteria, true),
      })
      expect(decision).toMatchObject({ continue: true, reason: "goal_mode" })
      expect(decision.reservation).toBeDefined()
      expect((yield* goals.get(active.goal.id)).goal).toMatchObject({ status: "active", auditorRuns: 1 })
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "continuation_pending" })
    }),
  )

  it.effect("settles Goal Mode immediately when the independent auditor proves a real blocker", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: blockedAudit(active.criteria, "Need a user-provided credential"),
      })

      expect(decision).toMatchObject({ continue: false, reason: "auditor_blocked" })
      expect(decision.reservation).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({
        status: "blocked",
        blocker: "Need a user-provided credential",
      })
      expect(yield* automation.runtime(sessionA)).toBeUndefined()
    }),
  )

  it.effect("keeps AUDIT ERROR visible when an explicit Goal Mode audit fails", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const requested = yield* automation.requestAudit(sessionA)
      expect(requested?.phase).toBe("audit_requested")
      yield* automation.failAudit({ sessionID: sessionA, error: "provider timeout" })

      expect(yield* automation.runtime(sessionA)).toMatchObject({
        phase: "audit_error",
        error: "provider timeout",
      })
      expect((yield* goals.get(active.goal.id)).goal).toMatchObject({ status: "active" })
    }),
  )

  it.effect("a user audit request supersedes a pending continuation and is startup-recoverable", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: continueAudit(active.criteria, true),
      })
      expect(decision.reservation).toBeDefined()

      expect(yield* automation.requestAudit(sessionA)).toMatchObject({ phase: "audit_requested" })
      expect(yield* automation.claim(sessionA)).toBeUndefined()
      expect(yield* automation.orphanedAuditSessions()).toContainEqual({
        sessionID: sessionA,
        directory: "/goal/project-a",
        workspaceID: workspaceA,
      })
    }),
  )

  it.effect("continues indefinitely across repeated no-progress audits while the Goal remains runnable", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      let decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: continueAudit(active.criteria, false),
      })
      for (let index = 0; index < 10; index++) {
        const claimed = yield* automation.claim(sessionA)
        expect(claimed?.id).toBe(decision.reservation?.id)
        decision = yield* automation.afterTurn({
          sessionID: sessionA,
          origin: "automatic",
          reservationID: claimed!.id,
          audit: continueAudit(active.criteria, false),
        })
        expect(decision.continue).toBe(true)
      }

      const durable = yield* goals.get(created.goal.id)
      expect(durable.goal).toMatchObject({ status: "active", blocker: undefined })
      expect(durable.goal.auditorRuns).toBeGreaterThan(8)
    }),
  )

  it.effect("finds only automatic verifying Goals with no runtime cursor for startup audit recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service

      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      const verifying = yield* goals.transition({
        id: active.goal.id,
        expectedRevision: active.goal.revision,
        action: "request_verification",
      })

      expect(verifying.goal.status).toBe("verifying")
      expect(yield* automation.runtime(sessionA)).toBeUndefined()
      expect(yield* automation.orphanedAuditSessions()).toContainEqual({
        sessionID: sessionA,
        directory: "/goal/project-a",
        workspaceID: workspaceA,
      })

      // An explicit runtime error is intentionally not auto-retried at startup;
      // otherwise a broken provider/catalog could create a reboot retry loop.
      yield* automation.failAudit({ sessionID: sessionA, error: "provider unavailable" })
      expect((yield* automation.runtime(sessionA))?.phase).toBe("audit_error")
      expect((yield* automation.orphanedAuditSessions()).some((item) => item.sessionID === sessionA)).toBe(false)
    }),
  )

  it.effect("persists a lifetime auditor run count on the Goal independently of automation cursor state", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })

      expect(active.goal.auditorRuns).toBe(0)
      const assessments = active.criteria.map((criterion) => ({
        criterionID: criterion.id,
        status: "pending" as const,
        evidence: "Not verified yet.",
      }))
      const first = yield* goals.reconcileAuditorVerdict({
        goalID: active.goal.id,
        expectedRevision: active.goal.revision,
        verdict: {
          decision: "continue",
          rationale: "More work remains.",
          progressMade: false,
          criteria: assessments,
          continuationPrompt: "Continue the next concrete step.",
        },
      })
      expect(first.changed).toBe(false)
      expect(first.detail.goal.revision).toBe(active.goal.revision)
      expect(first.detail.goal.auditorRuns).toBe(1)

      const second = yield* goals.reconcileAuditorVerdict({
        goalID: active.goal.id,
        expectedRevision: active.goal.revision,
        verdict: {
          decision: "continue",
          rationale: "Still not verified.",
          progressMade: false,
          criteria: assessments.map((assessment) => ({ ...assessment, evidence: "Still pending." })),
          continuationPrompt: "Continue once more.",
        },
      })
      expect(second.changed).toBe(false)
      expect(second.detail.goal.revision).toBe(active.goal.revision)
      expect(second.detail.goal.auditorRuns).toBe(2)

      yield* goals.recordAuditorVerdict({
        goalID: active.goal.id,
        verdict: {
          decision: "continue",
          rationale: "Recorded through the lower-level durable audit seam.",
          progressMade: false,
          criteria: assessments,
          continuationPrompt: "Continue after the recorded audit.",
        },
      })
      const recorded = yield* goals.get(active.goal.id)
      expect(recorded.goal.revision).toBe(active.goal.revision)
      expect(recorded.goal.auditorRuns).toBe(3)
    }),
  )

  it.effect("allows the independent auditor to downgrade an agent-reported provisional pass", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      const criterionID = active.criteria[0]!.id

      yield* goals.addEvidence({
        goalID: active.goal.id,
        expectedRevision: active.goal.revision,
        criterionID,
        type: "worker_report",
        summary: "Worker claims this criterion is done.",
        verdict: "passed",
        actor: "agent",
      })
      const withEvidence = yield* goals.get(active.goal.id)
      const provisionallyPassed = yield* goals.updateCriterion({
        goalID: active.goal.id,
        criterionID,
        expectedRevision: withEvidence.goal.revision,
        status: "passed",
        actor: "agent",
      })
      const auditorSessionID = yield* goals.auditorSession({ parentSessionID: sessionA, goalID: active.goal.id })

      const reconciled = yield* goals.reconcileAuditorVerdict({
        goalID: active.goal.id,
        expectedRevision: provisionallyPassed.goal.revision,
        sessionID: auditorSessionID,
        verdict: {
          decision: "continue",
          rationale: "The worker report is not independently sufficient.",
          progressMade: false,
          continuationPrompt: "Collect independent evidence for the provisional criterion.",
          criteria: provisionallyPassed.criteria.map((criterion) => ({
            criterionID: criterion.id,
            status: "pending" as const,
            evidence:
              criterion.id === criterionID
                ? "No host-owned independent verification exists yet."
                : "Unrelated criterion remains unsettled.",
          })),
        },
      })

      expect(reconciled.detail.criteria[0]?.status).toBe("pending")
      expect(reconciled.changed).toBe(true)
    }),
  )

  it.effect(
    "keeps independently passed criteria sticky across later auditor uncertainty while allowing concrete invalidation",
    () =>
      Effect.gen(function* () {
        yield* setup
        const goals = yield* GoalV2.Service
        const created = yield* createGoal()
        const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
        const criterionID = active.criteria[0]!.id
        const auditorSessionID = yield* goals.auditorSession({ parentSessionID: sessionA, goalID: active.goal.id })
        const assessments = (status: "pending" | "passed" | "failed", evidence: string) =>
          active.criteria.map((criterion) =>
            criterion.id === criterionID
              ? { criterionID: criterion.id, status, evidence }
              : {
                  criterionID: criterion.id,
                  status: "pending" as const,
                  evidence: "Unrelated criterion remains unsettled.",
                },
          )

        const passed = yield* goals.reconcileAuditorVerdict({
          goalID: active.goal.id,
          expectedRevision: active.goal.revision,
          sessionID: auditorSessionID,
          verdict: {
            decision: "continue",
            rationale: "The criterion is independently verified.",
            progressMade: true,
            continuationPrompt: "Continue remaining work.",
            criteria: assessments("passed", "Verified on the authoritative execution surface."),
          },
        })
        expect(passed.detail.criteria[0]?.status).toBe("passed")

        const uncertain = yield* goals.reconcileAuditorVerdict({
          goalID: active.goal.id,
          expectedRevision: passed.detail.goal.revision,
          sessionID: auditorSessionID,
          verdict: {
            decision: "continue",
            rationale: "The current auditor cannot reach the original execution surface.",
            progressMade: false,
            continuationPrompt: "Continue only genuinely unsettled work.",
            criteria: assessments("pending", "Current inspection scope cannot re-open the remote artifact."),
          },
        })
        expect(uncertain.detail.criteria[0]?.status).toBe("passed")
        expect(uncertain.changed).toBe(false)

        const invalidated = yield* goals.reconcileAuditorVerdict({
          goalID: active.goal.id,
          expectedRevision: uncertain.detail.goal.revision,
          sessionID: auditorSessionID,
          verdict: {
            decision: "continue",
            rationale: "New contradictory evidence invalidates the prior pass.",
            progressMade: true,
            continuationPrompt: "Repair the newly demonstrated regression.",
            criteria: assessments("failed", "A newer authoritative check demonstrates the criterion no longer holds."),
          },
        })
        expect(invalidated.detail.criteria[0]?.status).toBe("failed")
        expect(invalidated.changed).toBe(true)
      }),
  )

  it.effect("continues autonomously when a criterion currently fails but repair work remains", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        sourceMessageID: "msg_conclusive_negative_result",
        audit: {
          ok: true,
          verdict: {
            decision: "continue",
            rationale: "A required criterion currently fails, so the next worker cycle must repair it.",
            progressMade: false,
            continuationPrompt: "Repair the failing acceptance criterion and rerun the exact verification.",
            criteria: active.criteria.map((criterion, index) => ({
              criterionID: criterion.id,
              status: index === 0 ? ("failed" as const) : ("passed" as const),
              evidence:
                index === 0
                  ? "The held-out verification currently fails this criterion."
                  : "This criterion is independently verified.",
            })),
          },
        },
      })

      expect(decision.continue).toBe(true)
      expect(decision.reason).toBe("goal_mode")
      expect(decision.reservation?.prompt).toContain("Repair the failing acceptance criterion")
      expect(decision.goal?.goal.status).toBe("active")
      expect(decision.goal?.criteria.map((criterion) => criterion.status)).toEqual(["failed", "passed"])
      expect((yield* automation.runtime(sessionA))?.phase).toBe("continuation_pending")

      const durable = yield* goals.get(active.goal.id)
      expect(durable.goal.status).toBe("active")
    }),
  )

  it.effect("claims each continuation exactly once, preserves its causal root, and can release it for recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        sourceMessageID: "msg_goal_worker_root",
        audit: continueAudit(active.criteria, true),
      })
      expect(decision.continue).toBe(true)
      expect(decision.reservation?.id).toBeString()
      expect(decision.reservation?.sourceMessageID).toBe("msg_goal_worker_root")
      expect(decision.reservation?.prompt).toContain(
        "Continue with the next concrete Goal task and verify it with evidence.",
      )
      expect(decision.reservation?.prompt).toContain("<auditor-continuation>")

      const first = yield* automation.claim(sessionA)
      expect(first?.id).toBe(decision.reservation?.id)
      expect(first?.sourceMessageID).toBe("msg_goal_worker_root")
      expect(first?.prompt).toBe(decision.reservation?.prompt)
      expect(yield* automation.claim(sessionA)).toBeUndefined()

      yield* automation.release({ sessionID: sessionA, reservationID: first!.id })
      expect(yield* automation.pendingSessions()).toContain(sessionA)
      const recovered = yield* automation.claim(sessionA)
      expect(recovered?.id).toBe(first?.id)
      expect(recovered?.sourceMessageID).toBe("msg_goal_worker_root")
      expect(recovered?.prompt).toBe(first?.prompt)

      const continued = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "automatic",
        reservationID: recovered!.id,
        audit: continueAudit(active.criteria, true),
      })
      expect(continued.reservation?.sourceMessageID).toBe("msg_goal_worker_root")
    }),
  )

  it.effect(
    "requeues a same-process claimed continuation after runner interruption without changing its identity",
    () =>
      Effect.gen(function* () {
        yield* setup
        const goals = yield* GoalV2.Service
        const automation = yield* GoalAutomation.Service
        const created = yield* createGoal()
        const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
        yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

        const decision = yield* automation.afterTurn({
          sessionID: sessionA,
          origin: "user",
          sourceMessageID: "msg_goal_worker_root",
          audit: continueAudit(active.criteria, true),
        })
        const claimed = yield* automation.claim(sessionA)
        expect(claimed?.id).toBe(decision.reservation?.id)
        expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "working" })

        expect(yield* automation.requeueClaim(sessionA)).toBe(true)
        expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "continuation_pending" })
        expect(yield* automation.pendingSessions()).toContain(sessionA)
        expect(yield* automation.requeueClaim(sessionA)).toBe(false)

        const recovered = yield* automation.claim(sessionA)
        expect(recovered).toMatchObject({
          id: claimed!.id,
          sourceMessageID: "msg_goal_worker_root",
          prompt: claimed!.prompt,
        })
      }),
  )

  it.effect("defers an interrupted autonomous audit and reclaims it for audit without rerunning the worker", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        sourceMessageID: "msg_goal_worker_root",
        audit: continueAudit(active.criteria, true),
      })
      const claimed = yield* automation.claim(sessionA)
      expect(claimed?.id).toBe(decision.reservation?.id)

      const auditorSessionID = yield* goals.auditorSession({ parentSessionID: sessionA, goalID: active.goal.id })
      expect(
        yield* automation.beginAudit({
          sessionID: sessionA,
          auditorSessionID,
          reservationID: claimed!.id,
        }),
      ).toMatchObject({ phase: "auditing", auditorSessionID })

      expect(yield* automation.deferAudit(sessionA)).toBe(true)
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "audit_requested" })
      expect(yield* automation.pendingSessions()).not.toContain(sessionA)
      expect(yield* automation.claim(sessionA)).toBeUndefined()

      const recovery = yield* automation.claimAuditRecovery(sessionA)
      expect(recovery?.reservation).toMatchObject({
        id: claimed!.id,
        sourceMessageID: "msg_goal_worker_root",
        prompt: claimed!.prompt,
      })
      expect(
        yield* automation.beginAudit({
          sessionID: sessionA,
          auditorSessionID,
          reservationID: recovery!.reservation!.id,
        }),
      ).toMatchObject({ phase: "auditing", auditorSessionID })

      yield* automation.endAudit(sessionA)
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "working" })
      yield* automation.release({ sessionID: sessionA, reservationID: claimed!.id })
    }),
  )

  it.effect("user supersession deletes a claimed reservation so stale output cannot recreate it", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })
      yield* automation.afterTurn({ sessionID: sessionA, origin: "user", audit: continueAudit(active.criteria, true) })
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
        yield* db
          .select()
          .from(GoalAutomationTable)
          .where(eq(GoalAutomationTable.session_id, sessionA))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("does not let a late auditor verdict recreate automation after its runtime cursor was cancelled", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      expect(yield* automation.requestAudit(sessionA)).toMatchObject({ phase: "audit_requested" })
      yield* automation.cancel(sessionA)

      const late = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        requireAuditCursor: true,
        audit: continueAudit(active.criteria, true),
      })
      expect(late).toMatchObject({ continue: false, reason: "audit_superseded" })
      expect(yield* automation.runtime(sessionA)).toBeUndefined()
      expect(yield* automation.pendingSessions()).not.toContain(sessionA)

      // Without a concurrent cancellation the same production fence permits a
      // normal audited cycle to reserve its next continuation.
      expect(yield* automation.requestAudit(sessionA)).toMatchObject({ phase: "audit_requested" })
      const current = yield* goals.get(created.goal.id)
      const settled = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        requireAuditCursor: true,
        audit: continueAudit(current.criteria, true),
      })
      expect(settled.continue).toBe(true)
      expect(settled.reservation).toBeDefined()
    }),
  )

  it.effect("moves an auditor-complete Goal into formal verification without completing it", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: {
          ok: true,
          verdict: {
            decision: "complete",
            rationale: "The worker result satisfies the objective and is ready for verification.",
            progressMade: true,
            criteria: active.criteria.map((criterion) => ({
              criterionID: criterion.id,
              status: "passed",
              evidence: `Auditor independently verified: ${criterion.description}`,
            })),
          },
        },
      })

      expect(decision).toMatchObject({ continue: false, reason: "auditor_complete_verified" })
      const verified = yield* goals.get(created.goal.id)
      expect(verified.goal.status).toBe("completed")
      expect(verified.criteria.every((criterion) => criterion.status === "passed")).toBe(true)
      const auditorEvidence = yield* goals.evidence(created.goal.id)
      expect(auditorEvidence.filter((item) => item.type === "auditor_verification")).toHaveLength(
        active.criteria.length,
      )
    }),
  )

  it.effect("settles a genuine auditor blocker immediately and does not reserve another worker cycle", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: blockedAudit(active.criteria, "Need a user-provided deployment credential"),
      })
      expect(decision).toMatchObject({ continue: false, reason: "auditor_blocked" })
      expect(decision.reservation).toBeUndefined()
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({
        status: "blocked",
        blocker: "Need a user-provided deployment credential",
      })
      expect(yield* automation.runtime(sessionA)).toBeUndefined()
    }),
  )

  it.effect("stops automation without manufacturing a Goal blocker when the auditor is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const automation = yield* GoalAutomation.Service
      const created = yield* createGoal()
      const active = yield* goals.transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      yield* goals.focus({ goalID: active.goal.id, sessionID: sessionA })

      const auditorSessionID = yield* goals.auditorSession({ parentSessionID: sessionA, goalID: active.goal.id })
      const auditing = yield* automation.beginAudit({ sessionID: sessionA, auditorSessionID })
      expect(auditing?.phase).toBe("auditing")
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "auditing", auditorSessionID })
      // Lease acquisition is a DB CAS, not a caller-side check. A racing Retry
      // must not admit a second auditor after both callers observed idle state.
      expect(yield* automation.beginAudit({ sessionID: sessionA, auditorSessionID })).toBeUndefined()
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "auditing", auditorSessionID })

      const decision = yield* automation.afterTurn({
        sessionID: sessionA,
        origin: "user",
        audit: { ok: false, error: "provider timeout" },
      })
      expect(decision.continue).toBe(false)
      expect(decision.reason).toContain("auditor_error:provider timeout")
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({
        status: "active",
      })
      expect((yield* goals.get(created.goal.id)).goal.blocker).toBeUndefined()
      expect(yield* automation.runtime(sessionA)).toMatchObject({ phase: "audit_error", error: "provider timeout" })
    }),
  )
})
