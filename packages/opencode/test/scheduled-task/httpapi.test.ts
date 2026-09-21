import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { httpApiLayer, request } from "../server/httpapi-layer"
import { testEffect } from "../lib/effect"

/**
 * T6 verification plus D1/D2 at the transport boundary: every Tier 0
 * scheduled-task endpoint must work with NO directory context at all. If any
 * of them crossed InstanceContextMiddleware, a request without a directory
 * would either fail or silently fall back to process.cwd().
 */
const it = testEffect(httpApiLayer)

const json = <T>(response: { json: Effect.Effect<unknown, unknown> }) =>
  response.json.pipe(
    Effect.map((value) => value as T),
    Effect.orDie,
  )

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-scheduled-http-"))),
  (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
)

describe("scheduled-task HttpApi", () => {
  it.live("D1/D2/D20: Tier 0 list/agenda/binding/candidate reads answer without directory context or Instance bootstrap", () =>
    Effect.gen(function* () {
      const list = yield* request("/scheduled-task")
      expect(list.status).toBe(200)
      expect(yield* json<unknown[]>(list)).toEqual([])

      const preview = yield* request("/scheduled-task/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "America/New_York",
          count: 3,
        }),
      })
      expect(preview.status).toBe(200)
      const previewBody = yield* json<{ next: number[]; warnings: string[]; summary: string }>(preview)
      expect(previewBody.next).toHaveLength(3)
      expect(previewBody.summary).toBe("daily at 09:00")

      const agenda = yield* request(
        `/scheduled-task/agenda?${new URLSearchParams({
          from: String(Date.now()),
          to: String(Date.now() + 24 * 60 * 60 * 1_000),
        })}`,
      )
      expect(agenda.status).toBe(200)
      expect(yield* json<unknown[]>(agenda)).toEqual([])

      const control = yield* request("/scheduled-task/control")
      expect(control.status).toBe(200)
      expect(yield* json<{ paused: boolean }>(control)).toMatchObject({ paused: false })

      const inbox = yield* request("/scheduled-task/run")
      expect(inbox.status).toBe(200)
      expect(yield* json<unknown[]>(inbox)).toEqual([])

      const unread = yield* request("/scheduled-task/inbox/count")
      expect(unread.status).toBe(200)
      expect(yield* json<{ unread: number }>(unread)).toEqual({ unread: 0 })

      const directory = yield* temporaryDirectory
      const created = yield* request("/scheduled-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetDirectory: directory,
          name: "tier-zero-read-proof",
          enabled: false,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "UTC",
          action: { prompt: "prove Tier 0 reads" },
          sessionPolicy: { kind: "reuse" },
        }),
      })
      expect(created.status).toBe(200)
      const task = yield* json<{ id: string }>(created)

      const binding = yield* request(`/scheduled-task/${task.id}/session-binding`)
      expect(binding.status).toBe(200)
      expect(yield* json<unknown>(binding)).toBeNull()

      const candidates = yield* request(
        `/scheduled-task/session-candidate?${new URLSearchParams({ targetDirectory: directory, limit: "100" })}`,
      )
      expect(candidates.status).toBe(200)
      expect(yield* json<unknown[]>(candidates)).toEqual([])

      const paused = yield* request("/scheduled-task/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: true }),
      })
      expect(paused.status).toBe(200)
      expect(yield* json<{ paused: boolean }>(paused)).toMatchObject({ paused: true })
      const resumed = yield* request("/scheduled-task/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: false }),
      })
      expect(resumed.status).toBe(200)
      expect((yield* request(`/scheduled-task/${task.id}`, { method: "DELETE" })).status).toBe(204)
    }),
  )

  it.live("CRUD, toggle, run history, and the manual enqueue endpoint", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const headers = { "content-type": "application/json" }

      const created = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: directory,
          name: "http-api-task",
          enabled: true,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "America/New_York",
          action: { prompt: "hello" },
        }),
      })
      expect(created.status).toBe(200)
      const task = yield* json<{ id: string; nextRunAt: number; enabled: boolean; revision: number }>(created)
      expect(task.enabled).toBe(true)
      expect(typeof task.nextRunAt).toBe("number")

      const agenda = yield* request(
        `/scheduled-task/agenda?${new URLSearchParams({
          from: String(Date.now()),
          to: String(Date.now() + 24 * 60 * 60 * 1_000),
        })}`,
      )
      expect(agenda.status).toBe(200)
      expect((yield* json<Array<{ taskID: string }>>(agenda)).some((entry) => entry.taskID === task.id)).toBe(true)

      const got = yield* request(`/scheduled-task/${task.id}`)
      expect(got.status).toBe(200)

      const updated = yield* request(`/scheduled-task/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedRevision: task.revision, name: "http-api-task-2" }),
      })
      expect(updated.status).toBe(200)
      const updatedTask = yield* json<{ name: string; revision: number }>(updated)
      expect(updatedTask.name).toBe("http-api-task-2")

      const stale = yield* request(`/scheduled-task/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedRevision: task.revision, name: "stale-writer" }),
      })
      expect(stale.status).toBe(409)

      const disabled = yield* request(`/scheduled-task/${task.id}/enabled`, {
        method: "POST",
        headers,
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.status).toBe(200)
      expect(yield* json<{ enabled: boolean; nextRunAt?: number }>(disabled)).toMatchObject({ enabled: false })

      const runs = yield* request(`/scheduled-task/${task.id}/run`)
      expect(runs.status).toBe(200)
      expect(yield* json<unknown[]>(runs)).toEqual([])

      // Pause execution so this transport assertion proves the HTTP operation
      // itself is only a Tier 0 durable enqueue; no Instance may be required.
      const paused = yield* request("/scheduled-task/control", {
        method: "POST",
        headers,
        body: JSON.stringify({ paused: true }),
      })
      expect(paused.status).toBe(200)
      const runNow = yield* request(`/scheduled-task/${task.id}/run-now`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      expect(runNow.status).toBe(200)
      expect(yield* json<{ status: string; trigger: string }>(runNow)).toMatchObject({
        status: "queued",
        trigger: "manual",
      })

      const removed = yield* request(`/scheduled-task/${task.id}`, { method: "DELETE" })
      expect(removed.status).toBe(204)
      const resumed = yield* request("/scheduled-task/control", {
        method: "POST",
        headers,
        body: JSON.stringify({ paused: false }),
      })
      expect(resumed.status).toBe(200)

      const missing = yield* request(`/scheduled-task/${task.id}`)
      expect(missing.status).toBe(404)
    }),
  )

  it.live("accepts relative, timestamp, and recurring schedule input families while returning canonical schedules", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const headers = { "content-type": "application/json" }
      const before = Date.now()

      const relativeResponse = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: directory,
          name: "http-relative",
          enabled: true,
          schedule: { kind: "relative", delayMs: 60_000 },
          action: { prompt: "relative" },
        }),
      })
      expect(relativeResponse.status).toBe(200)
      const relative = yield* json<{ id: string; schedule: { kind: string; at?: number }; nextRunAt: number }>(relativeResponse)
      const after = Date.now()
      expect(relative.schedule.kind).toBe("once")
      expect(relative.schedule.at).toBeGreaterThanOrEqual(before + 60_000)
      expect(relative.schedule.at).toBeLessThanOrEqual(after + 60_000)
      expect(relative.nextRunAt).toBe(relative.schedule.at!)

      const at = after + 120_000
      const timestampResponse = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: directory,
          name: "http-timestamp",
          schedule: { kind: "timestamp", at },
          action: { prompt: "timestamp" },
        }),
      })
      expect(timestampResponse.status).toBe(200)
      expect(yield* json<{ schedule: unknown }>(timestampResponse)).toMatchObject({
        schedule: { kind: "once", at },
      })

      const recurringResponse = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: directory,
          name: "http-recurring",
          schedule: {
            kind: "recurring",
            schedule: { kind: "weekly", weekdays: [1, 3, 5], times: [{ hour: 9, minute: 30 }] },
          },
          timezone: "America/Chicago",
          action: { prompt: "recurring" },
        }),
      })
      expect(recurringResponse.status).toBe(200)
      expect(yield* json<{ schedule: unknown }>(recurringResponse)).toMatchObject({
        schedule: { kind: "weekly", weekdays: [1, 3, 5], times: [{ hour: 9, minute: 30 }] },
      })

      const previewBefore = Date.now()
      const previewResponse = yield* request("/scheduled-task/preview", {
        method: "POST",
        headers,
        body: JSON.stringify({ schedule: { kind: "relative", delayMs: 30_000 }, count: 1 }),
      })
      expect(previewResponse.status).toBe(200)
      const preview = yield* json<{ next: number[]; summary: string }>(previewResponse)
      expect(preview.next).toHaveLength(1)
      expect(preview.next[0]).toBeGreaterThanOrEqual(previewBefore + 30_000)
      expect(preview.summary).toContain("once at")
    }),
  )

  it.live("validates the wire contract (relative directory, sub-minute cron, unknown timezone)", () =>
    Effect.gen(function* () {
      const headers = { "content-type": "application/json" }
      const relative = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: "relative/path",
          name: "bad",
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          action: { prompt: "x" },
        }),
      })
      expect(relative.status).toBe(400)

      const seconds = yield* request("/scheduled-task/preview", {
        method: "POST",
        headers,
        body: JSON.stringify({ schedule: { kind: "cron", expression: "* * * * * *" } }),
      })
      // preview is pure and returns no occurrences for an invalid expression.
      expect(seconds.status).toBe(200)
      expect(yield* json<{ next: number[] }>(seconds)).toMatchObject({ next: [] })

      const zone = yield* request("/scheduled-task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetDirectory: os.tmpdir(),
          name: "bad-zone",
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "Not/AZone",
          action: { prompt: "x" },
        }),
      })
      expect(zone.status).toBe(400)
    }),
  )
})
