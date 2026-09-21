import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ScheduledTask.node, ScheduledTaskAgent.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const projectID = ProjectV2.ID.make("scheduled-agent-project")
const sessionID = SessionV2.ID.make("ses_scheduled_agent")
const childSessionID = SessionV2.ID.make("ses_scheduled_agent_child")
const model = {
  providerID: ProviderV2.ID.make("test-provider"),
  id: ModelV2.ID.make("test-model"),
  variant: ModelV2.VariantID.make("high"),
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/scheduled/agent-project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: projectID,
        slug: "scheduled-agent",
        directory: "/scheduled/agent-project",
        title: "Scheduled agent",
        version: "test",
        agent: "build",
        model,
      },
      {
        id: childSessionID,
        project_id: projectID,
        parent_id: sessionID,
        slug: "scheduled-agent-child",
        directory: "/scheduled/agent-project",
        title: "Scheduled agent child",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const input: ScheduledTaskAgent.Input = {
  name: "Morning dependency audit",
  schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
  timezone: "America/Chicago",
  prompt: "Run the dependency audit and summarize failures.",
}

const turn = (userText: string, userMessageID = "msg_schedule_origin") => ({
  userMessageID,
  userText,
})

describe("ScheduledTaskAgent", () => {
  it.effect("creates a durable enabled task from the root Session and preserves source-turn attribution", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const result = yield* agent.create(
        sessionID,
        input,
        turn("Schedule a task every morning at 9 to run the dependency audit."),
      )

      expect(result.created).toBe(true)
      expect(result.task).toMatchObject({
        projectID,
        targetDirectory: "/scheduled/agent-project",
        target: { kind: "directory" },
        name: input.name,
        enabled: true,
        source: "agent",
        sourceMessageID: "msg_schedule_origin",
      })
      expect(result.task.action).toEqual({
        prompt: input.prompt,
        agent: "build",
        model,
      })
      expect(result.task.policy).toMatchObject({
        catchUp: "skip",
        overrun: "skip",
        maxAttempts: 2,
        maxDurationMs: 30 * 60 * 1000,
        permission: "deny",
        notify: "failure",
      })
      expect(result.task.nextRunAt).toBeNumber()
    }),
  )

  it.effect("is idempotent for a retried tool call but refuses a same-name different authorization", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const authorization = turn("Schedule a task every morning at 9 to run the dependency audit.")
      const first = yield* agent.create(sessionID, input, authorization)
      const retry = yield* agent.create(sessionID, input, authorization)

      expect(retry.created).toBe(false)
      expect(retry.task.id).toBe(first.task.id)

      const conflict = yield* agent
        .create(sessionID, input, turn("Schedule a task every morning at 9 to run the dependency audit.", "msg_other"))
        .pipe(Effect.flip)
      expect(conflict.reason).toContain("different scheduled task")
    }),
  )

  it.effect("creates an explicitly requested draft as disabled", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* (yield* ScheduledTaskAgent.Service).create(
        sessionID,
        { ...input, name: "Draft dependency audit" },
        turn("Schedule the dependency audit every morning at 9, but leave it disabled.", "msg_draft"),
      )
      expect(result.task.enabled).toBe(false)
      expect(result.task.nextRunAt).toBeUndefined()
    }),
  )

  it.effect("normalizes irrelevant timezone from once schedules for retry idempotency", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const at = Date.now() + 60_000
      const authorization = turn("Schedule this once in one minute.", "msg_once")
      const first = yield* agent.create(
        sessionID,
        {
          name: "One-shot dependency audit",
          schedule: { kind: "once", at },
          timezone: "America/Chicago",
          prompt: "Run the dependency audit once.",
        },
        authorization,
      )
      const retry = yield* agent.create(
        sessionID,
        {
          name: "One-shot dependency audit",
          schedule: { kind: "once", at },
          prompt: "Run the dependency audit once.",
        },
        authorization,
      )

      expect(first.task.timezone).toBeUndefined()
      expect(retry.created).toBe(false)
      expect(retry.task.id).toBe(first.task.id)
    }),
  )

  it.effect("resolves relative one-shots once and keeps retried tool calls idempotent", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const authorization = turn("Schedule this in 90 seconds.", "msg_relative")
      const request: ScheduledTaskAgent.Input = {
        name: "Relative dependency audit",
        schedule: { kind: "relative", delayMs: 90_000 },
        prompt: "Run the dependency audit once.",
      }
      const before = Date.now()
      const first = yield* agent.create(sessionID, request, authorization)
      const retry = yield* agent.create(sessionID, request, authorization)
      const after = Date.now()

      expect(first.task.schedule.kind).toBe("once")
      if (first.task.schedule.kind === "once") {
        expect(first.task.schedule.at).toBeGreaterThanOrEqual(before + 90_000)
        expect(first.task.schedule.at).toBeLessThanOrEqual(after + 90_000)
      }
      expect(first.task.timezone).toBeUndefined()
      expect(retry.created).toBe(false)
      expect(retry.task.id).toBe(first.task.id)
      expect(retry.task.schedule).toEqual(first.task.schedule)
    }),
  )

  it.effect("rejects an ambiguous wall-clock schedule instead of inheriting the host timezone", () =>
    Effect.gen(function* () {
      yield* setup
      const failure = yield* (yield* ScheduledTaskAgent.Service)
        .create(
          sessionID,
          { ...input, name: "Ambiguous dependency audit", timezone: undefined },
          turn("Schedule the dependency audit every morning at 9.", "msg_ambiguous_zone"),
        )
        .pipe(Effect.flip)
      expect(failure.reason).toContain("timezone is required")
      expect(failure.reason).toContain("rather than guessing")
    }),
  )

  it.effect("rejects unsolicited creation before writing durable state", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const failure = yield* agent.create(sessionID, input, turn("Please fix the dependency audit.")).pipe(Effect.flip)
      expect(failure.reason).toContain("did not explicitly request scheduling")
      expect(yield* ScheduledTask.Service.use((tasks) => tasks.findByName({ projectID, name: input.name }))).toBeUndefined()
    }),
  )

  it.effect("rejects child Session ownership rather than creating hidden durable automation", () =>
    Effect.gen(function* () {
      yield* setup
      const failure = yield* (yield* ScheduledTaskAgent.Service)
        .create(childSessionID, input, turn("Schedule this every day at 9."))
        .pipe(Effect.flip)
      expect(failure.reason).toContain("child Sessions cannot create scheduled tasks")
    }),
  )

  it.effect("lists, updates, toggles, inspects runs, and queues manual runs within the parent Session scope", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const created = yield* agent.create(
        sessionID,
        { ...input, name: "Manageable audit" },
        turn("Schedule a task every morning at 9 to run the dependency audit.", "msg_manage_create"),
      )

      const listed = yield* agent.execute(sessionID, { action: "list" })
      expect(listed.action).toBe("list")
      if (listed.action !== "list") return
      expect(listed.tasks.map((task) => task.id)).toContain(created.task.id)

      const fetched = yield* agent.execute(sessionID, { action: "get", taskID: created.task.id })
      expect(fetched.action).toBe("get")
      if (fetched.action !== "get") return

      const updated = yield* agent.execute(
        sessionID,
        {
          action: "update",
          taskID: created.task.id,
          expectedRevision: fetched.task.revision,
          name: "Renamed manageable audit",
        },
        turn("Rename the scheduled task to Renamed manageable audit.", "msg_manage_update"),
      )
      expect(updated.action).toBe("update")
      if (updated.action !== "update") return
      expect(updated.task.name).toBe("Renamed manageable audit")

      const disabled = yield* agent.execute(
        sessionID,
        {
          action: "set_enabled",
          taskID: created.task.id,
          enabled: false,
          expectedRevision: updated.task.revision,
        },
        turn("Disable that scheduled task.", "msg_manage_disable"),
      )
      expect(disabled.action).toBe("set_enabled")
      if (disabled.action !== "set_enabled") return
      expect(disabled.task.enabled).toBe(false)

      const queued = yield* agent.execute(
        sessionID,
        { action: "run_now", taskID: created.task.id, expectedRevision: disabled.task.revision },
        turn("Run that scheduled task now.", "msg_manage_run_now"),
      )
      expect(queued.action).toBe("run_now")
      if (queued.action !== "run_now") return
      expect(queued.run.taskID).toBe(created.task.id)
      expect(queued.run.trigger).toBe("manual")
      expect(queued.run.status).toBe("queued")

      const runs = yield* agent.execute(sessionID, { action: "runs", taskID: created.task.id, limit: 10 })
      expect(runs.action).toBe("runs")
      if (runs.action !== "runs") return
      expect(runs.runs.map((run) => run.id)).toContain(queued.run.id)
    }),
  )

  it.effect("requires explicit current-user authorization for management mutations and stale revisions fail closed", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const created = yield* agent.create(
        sessionID,
        { ...input, name: "Protected audit" },
        turn("Schedule a task every morning at 9 to run the dependency audit.", "msg_protected_create"),
      )

      const denied = yield* agent
        .execute(
          sessionID,
          {
            action: "set_enabled",
            taskID: created.task.id,
            enabled: false,
            expectedRevision: created.task.revision,
          },
          turn("Please inspect the dependency audit."),
        )
        .pipe(Effect.flip)
      expect(denied._tag).toBe("ScheduledTask.ValidationError")
      if (denied._tag === "ScheduledTask.ValidationError") expect(denied.reason).toContain("did not explicitly request")

      const renamed = yield* agent.execute(
        sessionID,
        {
          action: "update",
          taskID: created.task.id,
          expectedRevision: created.task.revision,
          name: "Protected audit renamed",
        },
        turn("Rename that scheduled task to Protected audit renamed."),
      )
      expect(renamed.action).toBe("update")

      const stale = yield* agent
        .execute(
          sessionID,
          {
            action: "set_enabled",
            taskID: created.task.id,
            enabled: false,
            expectedRevision: created.task.revision,
          },
          turn("Disable that scheduled task."),
        )
        .pipe(Effect.flip)
      expect(stale._tag).toBe("ScheduledTask.StaleRevisionError")
    }),
  )

  it.effect("scopes inbox/count to the parent Session and requires consent to acknowledge a run", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* ScheduledTaskAgent.Service
      const tasks = yield* ScheduledTask.Service
      const created = yield* agent.create(
        sessionID,
        { ...input, name: "Inbox audit" },
        turn("Schedule a task every morning at 9 to run the dependency audit.", "msg_inbox_create"),
      )
      const started = yield* tasks.recordRunStart({
        taskID: created.task.id,
        fireFor: Date.now() + 500_000,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: Date.now(),
      })
      if (started.kind !== "started") throw new Error("expected fresh scheduled run")
      yield* tasks.settleRun({
        taskID: created.task.id,
        runID: started.run.id,
        fireFor: started.run.fireFor,
        status: "failed",
        errorKind: "config",
        now: Date.now(),
        attempt: 1,
      })

      const inbox = yield* agent.execute(sessionID, { action: "inbox", unreadOnly: true })
      expect(inbox.action).toBe("inbox")
      if (inbox.action !== "inbox") return
      expect(inbox.runs.map((run) => run.id)).toContain(started.run.id)

      const count = yield* agent.execute(sessionID, { action: "unread_count" })
      expect(count).toEqual({ action: "unread_count", unread: 1 })

      const denied = yield* agent
        .execute(
          sessionID,
          {
            action: "acknowledge",
            taskID: created.task.id,
            runID: started.run.id,
            expectedRevision: created.task.revision,
          },
          turn("Show me that scheduled task result."),
        )
        .pipe(Effect.flip)
      expect(denied._tag).toBe("ScheduledTask.ValidationError")

      const acknowledged = yield* agent.execute(
        sessionID,
        {
          action: "acknowledge",
          taskID: created.task.id,
          runID: started.run.id,
          expectedRevision: created.task.revision,
        },
        turn("Mark that scheduled task result as read."),
      )
      expect(acknowledged).toEqual({
        action: "acknowledge",
        taskID: created.task.id,
        runID: started.run.id,
        acknowledged: true,
      })
      expect(yield* agent.execute(sessionID, { action: "unread_count" })).toEqual({
        action: "unread_count",
        unread: 0,
      })
    }),
  )
})
