import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskPolicy } from "@opencode-ai/core/scheduled-task/policy"
import { ScheduledTaskRecurrence } from "@opencode-ai/core/scheduled-task/recurrence"
import { ScheduledTaskSchema } from "@opencode-ai/core/scheduled-task/schema"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpSchedule } from "@/oxp/schedule"
import { OxpScheduleManagement } from "@/oxp/schedule-management"
import { ScheduledTaskWake } from "@/scheduled-task/wake"

const suite = path.join(os.tmpdir(), "opencode-oxp-schedule-" + randomUUID())
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })

const createdInputs: ScheduledTask.CreateInput[] = []
const tasks = new Map<string, ScheduledTask.Info>()
const runs = new Map<string, ScheduledTask.Run[]>()

function taskByID(id: ScheduledTask.ID) {
  return [...tasks.values()].find((task) => task.id === id)
}

function taskFrom(input: ScheduledTask.CreateInput): ScheduledTask.Info {
  const now = input.now ?? Date.now()
  const resolved = ScheduledTaskRecurrence.resolveScheduleInput(input.schedule, now)
  if (!resolved.ok) throw new Error(resolved.reason)
  return {
    id: ScheduledTask.ID.create(),
    ...(input.projectID === undefined ? {} : { projectID: input.projectID }),
    targetDirectory: input.targetDirectory,
    target: input.target ?? { kind: "directory" },
    sessionPolicy: input.sessionPolicy ?? { kind: "new" },
    name: input.name.trim(),
    enabled: input.enabled ?? false,
    revision: 0,
    schedule: resolved.schedule,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    action: input.action,
    policy: ScheduledTaskPolicy.resolvePolicy(input.policy),
    consecutiveFailures: 0,
    source: input.source ?? "api",
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    ...(input.sourceMessageID === undefined ? {} : { sourceMessageID: input.sourceMessageID }),
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
    ...(input.sourcePrincipal === undefined ? {} : { sourcePrincipal: input.sourcePrincipal }),
    time: {
      created: DateTime.makeUnsafe(now),
      updated: DateTime.makeUnsafe(now),
    },
  }
}

const writerLayer = Layer.succeed(
  OxpSchedule.Writer,
  OxpSchedule.Writer.of({
    create: (input) => {
      createdInputs.push(input)
      const name = input.name.trim()
      if (tasks.has(name)) {
        return Effect.fail(
          new ScheduledTaskSchema.ValidationError({ reason: 'a scheduled task named "' + name + '" already exists' }),
        )
      }
      const task = taskFrom(input)
      tasks.set(name, task)
      return Effect.succeed(task)
    },
    findByName: (name) => Effect.succeed(tasks.get(name.trim())),
    list: () => Effect.succeed([...tasks.values()]),
    get: (id) => {
      const task = taskByID(id)
      return task
        ? Effect.succeed(task)
        : Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: id }))
    },
    update: (input) => {
      const current = taskByID(input.id)
      if (!current) return Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: input.id }))
      if (current.revision !== input.expectedRevision) {
        return Effect.fail(new ScheduledTaskSchema.StaleRevisionError({
          taskID: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        }))
      }
      const resolved =
        input.schedule === undefined
          ? undefined
          : ScheduledTaskRecurrence.resolveScheduleInput(input.schedule, input.now ?? Date.now())
      if (resolved && !resolved.ok) return Effect.fail(new ScheduledTaskSchema.ValidationError({ reason: resolved.reason }))
      const next: ScheduledTask.Info = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.targetDirectory === undefined ? {} : { targetDirectory: input.targetDirectory }),
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.sessionPolicy === undefined ? {} : { sessionPolicy: input.sessionPolicy }),
        ...(resolved?.ok ? { schedule: resolved.schedule } : {}),
        ...(input.timezone === undefined
          ? {}
          : input.timezone === null
            ? { timezone: undefined }
            : { timezone: input.timezone }),
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.policy === undefined ? {} : { policy: ScheduledTaskPolicy.resolvePolicy(input.policy) }),
        revision: current.revision + 1,
        time: { ...current.time, updated: DateTime.makeUnsafe(Date.now()) },
      }
      tasks.delete(current.name)
      tasks.set(next.name, next)
      return Effect.succeed(next)
    },
    removeChecked: (input) => {
      const current = taskByID(input.id)
      if (!current) return Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: input.id }))
      if (current.revision !== input.expectedRevision) {
        return Effect.fail(new ScheduledTaskSchema.StaleRevisionError({
          taskID: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        }))
      }
      tasks.delete(current.name)
      runs.delete(current.id)
      return Effect.void
    },
    setEnabled: (input) => {
      const current = taskByID(input.id)
      if (!current) return Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: input.id }))
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        return Effect.fail(new ScheduledTaskSchema.StaleRevisionError({
          taskID: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        }))
      }
      const next = {
        ...current,
        enabled: input.enabled,
        revision: current.revision + 1,
        ...(input.enabled ? {} : { nextRunAt: undefined }),
        time: { ...current.time, updated: DateTime.makeUnsafe(Date.now()) },
      } satisfies ScheduledTask.Info
      tasks.set(next.name, next)
      return Effect.succeed(next)
    },
    listRuns: (input) => Effect.succeed((runs.get(input.taskID) ?? []).slice(0, input.limit ?? 50)),
    inbox: (input) => {
      const ids = input?.taskIDs ? new Set(input.taskIDs) : undefined
      const rows = [...runs.values()]
        .flat()
        .filter((run) => !ids || ids.has(run.taskID))
        .filter((run) => !input?.unreadOnly || run.acknowledgedAt === undefined)
        .sort((left, right) => right.startedAt - left.startedAt)
        .slice(0, input?.limit ?? 50)
      return Effect.succeed(rows)
    },
    unreadCount: (input) => {
      const ids = input?.taskIDs ? new Set(input.taskIDs) : undefined
      return Effect.succeed(
        [...runs.values()]
          .flat()
          .filter((run) => !ids || ids.has(run.taskID))
          .filter((run) => run.acknowledgedAt === undefined).length,
      )
    },
    acknowledgeChecked: (input) => {
      const current = taskByID(input.taskID)
      if (!current) return Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: input.taskID }))
      if (current.revision !== input.expectedRevision) {
        return Effect.fail(new ScheduledTaskSchema.StaleRevisionError({
          taskID: input.taskID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        }))
      }
      const rows = runs.get(input.taskID) ?? []
      const index = rows.findIndex((run) => run.id === input.runID)
      if (index === -1) return Effect.fail(new ScheduledTaskSchema.RunNotFoundError({ runID: input.runID }))
      const next = [...rows]
      next[index] = { ...next[index]!, acknowledgedAt: input.now ?? Date.now() }
      runs.set(input.taskID, next)
      return Effect.void
    },
    agenda: () => Effect.succeed([]),
    enqueueManualRun: (input) => {
      const current = taskByID(input.taskID)
      if (!current) return Effect.fail(new ScheduledTaskSchema.NotFoundError({ taskID: input.taskID }))
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        return Effect.fail(new ScheduledTaskSchema.StaleRevisionError({
          taskID: input.taskID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        }))
      }
      const run: ScheduledTask.Run = {
        id: ScheduledTask.RunID.create(),
        taskID: current.id,
        fireFor: input.now,
        trigger: "manual",
        status: "queued",
        sessionID: "ses_oxp_hidden" as any,
        goalID: "goal_oxp_hidden" as any,
        workspaceID: "wrk_oxp_hidden" as any,
        directory: current.targetDirectory,
        errorMessage: `native failure at ${current.targetDirectory}`,
        startedAt: input.now,
      }
      runs.set(current.id, [run, ...(runs.get(current.id) ?? [])])
      return Effect.succeed(run)
    },
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([OxpSchedule.node, OxpScheduleManagement.node, OxpRoot.node, OxpConfig.node]),
  [
    [Global.node, globalLayer],
    [OxpSchedule.writerNode, writerLayer],
  ],
)
const live = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, OxpSchedule.Service | OxpScheduleManagement.Service | OxpRoot.Service | OxpConfig.Service>,
) => test(name, () => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer))))

beforeEach(async () => {
  createdInputs.length = 0
  tasks.clear()
  runs.clear()
  ScheduledTaskWake.install(undefined)
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => {
  ScheduledTaskWake.install(undefined)
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OxpSchedule", () => {
  live(
    "keeps durable automation default-off even when OXP and an approved root are enabled",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const schedule = yield* OxpSchedule.Service
      const rootDir = path.join(suite, "workspace-default-off")
      yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)

      const denied = yield* schedule
        .execute({
          name: "default-off",
          rootID: root.id,
          schedule: { kind: "once", at: Date.now() + 60_000 },
          prompt: "Inspect the repository",
        })
        .pipe(Effect.flip)

      expect(denied._tag).toBe("OXP_AUTH_DENIED")
      expect(createdInputs).toHaveLength(0)
    }),
  )

  live(
    "persists the approved canonical directory without inventing project ownership",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const schedule = yield* OxpSchedule.Service
      const rootDir = path.join(suite, "workspace-projectless")
      const nested = path.join(rootDir, "nested")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })

      const result = yield* schedule.execute({
        name: "canonical-projectless",
        rootID: root.id,
        path: "nested",
        schedule: { kind: "once", at: Date.now() + 60_000 },
        prompt: "Run a bounded audit",
      })

      expect(result.structured).toMatchObject({ created: true })
      expect(createdInputs).toHaveLength(1)
      const input = createdInputs[0]!
      const resolved = yield* roots.resolvePath("nested", { rootID: root.id })
      expect(input.projectID).toBeUndefined()
      expect(input.targetDirectory).toBe(resolved.path)
      expect(input.target).toEqual({ kind: "directory" })
      expect(input.source).toBe("oxp")
      expect(input.sourcePrincipal).toMatch(/^[0-9a-f-]{36}$/i)
      expect(input.sourceRef).toMatch(/^[0-9a-f-]{36}$/i)
      expect(tasks.get("canonical-projectless")?.projectID).toBeUndefined()
      const projected = JSON.parse(result.output) as { targetDirectory?: string }
      expect(projected.targetDirectory).toBe(resolved.virtualPath)
      expect(projected.targetDirectory).not.toContain(input.targetDirectory)
      expect(result.output).not.toContain(input.targetDirectory)
    }),
  )

  live(
    "requires explicit wall-clock timezone before reaching durable persistence",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const schedule = yield* OxpSchedule.Service
      const rootDir = path.join(suite, "workspace-timezone")
      yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })

      const denied = yield* schedule
        .execute({
          name: "ambiguous-wall-clock",
          rootID: root.id,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          prompt: "Run every morning",
        })
        .pipe(Effect.flip)

      expect(denied._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(denied.detail).toContain("timezone is required")
      expect(createdInputs).toHaveLength(0)
    }),
  )

  live(
    "converges exact retries and fails closed on a same-name request for another approved root",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const schedule = yield* OxpSchedule.Service
      const firstDir = path.join(suite, "workspace-retry-a")
      const secondDir = path.join(suite, "workspace-retry-b")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(firstDir, { recursive: true }),
          fs.mkdir(secondDir, { recursive: true }),
        ]),
      )
      const firstRoot = yield* roots.approve(firstDir)
      const secondRoot = yield* roots.approve(secondDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })
      const at = Date.now() + 60_000
      const request = {
        name: "retry-safe",
        rootID: firstRoot.id,
        schedule: { kind: "once" as const, at },
        prompt: "Run once",
      }

      const first = yield* schedule.execute(request)
      const retry = yield* schedule.execute(request)
      const conflict = yield* schedule
        .execute({ ...request, rootID: secondRoot.id })
        .pipe(Effect.flip)

      expect(first.structured).toMatchObject({ created: true })
      expect(retry.structured).toMatchObject({ created: false })
      expect(tasks).toHaveLength(1)
      expect(conflict._tag).toBe("OXP_CONFLICT")
      expect(conflict.detail).toContain("different scheduled task")
      expect(tasks.get("retry-safe")?.targetDirectory).toBe((yield* roots.resolveRoot(firstRoot.id)).canonicalPath)
    }),
  )

  live(
    "manages the full task lifecycle inside one approved root without leaking native paths or cross-root task identity",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const create = yield* OxpSchedule.Service
      const schedule = yield* OxpScheduleManagement.Service
      const firstDir = path.join(suite, "workspace-manage-a")
      const secondDir = path.join(suite, "workspace-manage-b")
      yield* Effect.promise(() => Promise.all([
        fs.mkdir(firstDir, { recursive: true }),
        fs.mkdir(secondDir, { recursive: true }),
      ]))
      const firstRoot = yield* roots.approve(firstDir)
      const secondRoot = yield* roots.approve(secondDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })

      const firstCreated = yield* create.execute({
        name: "Managed first task",
        rootID: firstRoot.id,
        schedule: { kind: "once", at: Date.now() + 60_000 },
        prompt: "Run first task",
      })
      const secondCreated = yield* create.execute({
        name: "Managed second task",
        rootID: secondRoot.id,
        schedule: { kind: "once", at: Date.now() + 120_000 },
        prompt: "Run second task",
      })
      const firstTaskID = (firstCreated.metadata?.taskID ?? "") as ScheduledTask.ID
      const secondTaskID = (secondCreated.metadata?.taskID ?? "") as ScheduledTask.ID

      const listed = yield* schedule.execute({ action: "list", rootID: firstRoot.id })
      const listedRows = (listed.structured as { tasks: Array<{ id: string; targetDirectory: string }> }).tasks
      expect(listedRows.map((task) => task.id)).toEqual([firstTaskID])
      expect(listedRows[0]?.targetDirectory).toBe(`/${firstRoot.alias}`)
      expect(listed.output).not.toContain(firstDir)
      expect(listed.output).not.toContain(secondDir)

      const hidden = yield* schedule.execute({ action: "get", rootID: firstRoot.id, taskID: secondTaskID }).pipe(Effect.flip)
      expect(hidden._tag).toBe("OXP_NOT_FOUND")

      const fetched = yield* schedule.execute({ action: "get", rootID: firstRoot.id, taskID: firstTaskID })
      const initial = (fetched.structured as { task: ScheduledTask.Info }).task
      const updated = yield* schedule.execute({
        action: "update",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        expectedRevision: initial.revision,
        name: "Managed first task renamed",
      })
      const updatedTask = (updated.structured as { task: ScheduledTask.Info }).task
      expect(updatedTask.name).toBe("Managed first task renamed")

      const stale = yield* schedule.execute({
        action: "set_enabled",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        enabled: false,
        expectedRevision: initial.revision,
      }).pipe(Effect.flip)
      expect(stale._tag).toBe("OXP_CONFLICT")

      const disabled = yield* schedule.execute({
        action: "set_enabled",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        enabled: false,
        expectedRevision: updatedTask.revision,
      })
      const disabledTask = (disabled.structured as { task: ScheduledTask.Info }).task
      expect(disabledTask.enabled).toBe(false)

      let wakes = 0
      ScheduledTaskWake.install(async () => {
        wakes += 1
      })
      const queued = yield* schedule.execute({
        action: "run_now",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        expectedRevision: disabledTask.revision,
      })
      const queuedBody = queued.structured as { run: ScheduledTask.Run; wakeRequested: boolean }
      expect(queuedBody.run.trigger).toBe("manual")
      expect(queuedBody.run.status).toBe("queued")
      expect(queuedBody.wakeRequested).toBe(true)
      expect(wakes).toBe(1)
      expect(queued.output).not.toContain(firstDir)
      expect(queued.output).not.toContain("ses_oxp_hidden")
      expect(queued.output).not.toContain("goal_oxp_hidden")
      expect(queued.output).not.toContain("wrk_oxp_hidden")
      expect(queued.output).not.toContain("native failure")

      const history = yield* schedule.execute({ action: "runs", rootID: firstRoot.id, taskID: firstTaskID })
      const historyRuns = (history.structured as { runs: ScheduledTask.Run[] }).runs
      expect(historyRuns.map((run) => run.id)).toContain(queuedBody.run.id)
      expect(history.output).not.toContain(firstDir)
      expect(history.output).not.toContain("ses_oxp_hidden")

      const inbox = yield* schedule.execute({ action: "inbox", rootID: firstRoot.id, unreadOnly: true })
      const inboxRuns = (inbox.structured as { runs: ScheduledTask.Run[] }).runs
      expect(inboxRuns.map((run) => run.id)).toContain(queuedBody.run.id)
      expect(inbox.output).not.toContain(firstDir)
      expect(inbox.output).not.toContain("ses_oxp_hidden")

      const unread = yield* schedule.execute({ action: "unread_count", rootID: firstRoot.id })
      expect(unread.structured).toMatchObject({ action: "unread_count", unread: 1 })

      const acknowledged = yield* schedule.execute({
        action: "acknowledge",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        runID: queuedBody.run.id,
        expectedRevision: disabledTask.revision,
      })
      expect(acknowledged.structured).toMatchObject({
        action: "acknowledge",
        taskID: firstTaskID,
        runID: queuedBody.run.id,
        acknowledged: true,
      })
      const afterAck = yield* schedule.execute({ action: "unread_count", rootID: firstRoot.id })
      expect(afterAck.structured).toMatchObject({ action: "unread_count", unread: 0 })

      const removed = yield* schedule.execute({
        action: "remove",
        rootID: firstRoot.id,
        taskID: firstTaskID,
        expectedRevision: disabledTask.revision,
      })
      expect(removed.structured).toMatchObject({ removed: true, taskID: firstTaskID })
      const after = yield* schedule.execute({ action: "list", rootID: firstRoot.id })
      expect((after.structured as { tasks: unknown[] }).tasks).toEqual([])
    }),
  )

  live(
    "previews recurrence through the shared schedule engine without durable writes",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const schedule = yield* OxpScheduleManagement.Service
      const rootDir = path.join(suite, "workspace-preview")
      yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })

      const result = yield* schedule.execute({
        action: "preview",
        rootID: root.id,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/Chicago",
        count: 3,
      })
      expect((result.structured as { preview: { next: number[] } }).preview.next).toHaveLength(3)
      expect(createdInputs).toHaveLength(0)
    }),
  )

  test("has no project/Instance resolver dependency on the Tier-0/1 persistence bridge", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/schedule.ts"), "utf8")
    for (const forbidden of [
      /InstanceStore/,
      /InstanceState/,
      /ProjectV2/,
      /Project\.fromDirectory/,
      /from ["']@\/project(?:\/|["'])/,
      /from ["']@opencode-ai\/core\/project(?:\/|["'])/,
    ]) {
      expect(source).not.toMatch(forbidden)
    }
    expect(source).toContain("AppNodeBuilder.build(ScheduledTask.node)")
  })
})
