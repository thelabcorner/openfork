import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest"
import { Goal } from "../src/goal"
import { SessionID } from "../src/session-id"

test("Goal automation runtime distinguishes live auditing from auditor failure and lifecycle state", () => {
  const decodePhase = Schema.decodeUnknownSync(Goal.AutomationPhase)
  const decodeRuntime = Schema.decodeUnknownSync(Goal.AutomationRuntime)

  expect(decodePhase("auditing")).toBe("auditing")
  expect(decodePhase("audit_requested")).toBe("audit_requested")
  expect(decodePhase("audit_error")).toBe("audit_error")
  expect(() => decodePhase("blocked")).toThrow()
  expect(
    decodeRuntime({ phase: "auditing", since: Date.now(), auditorSessionID: "ses_goal_auditor_runtime" }),
  ).toMatchObject({ phase: "auditing", auditorSessionID: "ses_goal_auditor_runtime" })
  expect(() => decodeRuntime({ phase: "auditing", since: Date.now() })).toThrow()
  expect(decodeRuntime({ phase: "audit_requested", since: Date.now() })).toMatchObject({
    phase: "audit_requested",
  })
  expect(decodeRuntime({ phase: "audit_error", since: Date.now(), error: "model unavailable" })).toMatchObject({
    phase: "audit_error",
    error: "model unavailable",
  })
  expect(Goal.Event.Definitions).toContain(Goal.Event.AutomationUpdated)
  expect(Goal.Event.AutomationUpdated.type).toBe("goal.automation.updated")
  expect(EventManifest.Latest.get("goal.automation.updated")).toBe(Goal.Event.AutomationUpdated)
})

test("focused Goal projects a durable auditor child independently of live automation", () => {
  const decode = Schema.decodeUnknownSync(Goal.FocusedGoal)
  const now = Date.now()
  const focused = decode({
    focus: {
      sessionID: "ses_goal_owner",
      goalID: "gol_runtime_projection",
      role: "owner",
      focusedAt: now,
    },
    detail: {
      goal: {
        id: "gol_runtime_projection",
        projectID: "proj_runtime_projection",
        title: "Runtime projection",
        objective: "Keep the auditor transcript inspectable",
        constraints: [],
        status: "active",
        revision: 1,
        auditorRuns: 1,
        continuationPolicy: { mode: "auto_continue" },
        auditorPolicy: {},
        time: { created: now, updated: now },
      },
      criteria: [],
      steps: [],
    },
    auditorSessionID: "ses_goal_auditor_durable",
  })

  expect(focused.auditorSessionID).toBe(SessionID.make("ses_goal_auditor_durable"))
  expect(focused.automation).toBeUndefined()
})
