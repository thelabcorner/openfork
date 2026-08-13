export * as SessionUsage from "./usage"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"

/** Provider ID billed against the OpenCode Go plan's rolling budgets. */
const GO_PROVIDER_ID = "opencode-go"

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Dollar limits for the OpenCode Go plan's rolling windows. */
const LIMITS = { "5h": 12, week: 30, month: 60 } as const

export interface WindowUsage {
  readonly label: "5h" | "week" | "month"
  readonly spentUSD: number
  readonly limitUSD: number
  readonly resetsAt: number
  readonly clearsAt: number
  readonly lastUsedAt?: number
  readonly callsInWindow: number
}

export interface MessageCost {
  readonly messageID: string
  readonly cost: number
  readonly createdMs: number
}

export interface WindowBounds {
  readonly label: "5h" | "week" | "month"
  readonly startMs: number
  readonly endMs: number
  readonly limitUSD: number
  readonly resetsAt: number
}

export interface Interface {
  readonly goPlan: () => Effect.Effect<WindowUsage[]>
  /** Raw per-message opencode-go cost rows since `sinceMs`, for callers that need per-credential attribution. */
  readonly rows: (sinceMs: number) => Effect.Effect<MessageCost[]>
  /** The 5h/week/month window boundaries (no aggregation), reusable by callers that group rows their own way. */
  readonly windows: () => Effect.Effect<WindowBounds[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionUsage") {}

/** UTC-Monday-anchored week start, matching the OpenCode Go usage tray. */
const weekStart = (nowMs: number) => {
  const date = new Date(nowMs)
  const offset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - offset)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

const shiftMonth = (year: number, month: number, delta: number): [number, number] => {
  const total = year * 12 + month + delta
  return [Math.floor(total / 12), ((total % 12) + 12) % 12]
}

/** Month window anchored to the day/time of the earliest observed Go usage, falling back to the calendar month. */
const monthBounds = (nowMs: number, anchorMs: number | undefined) => {
  if (anchorMs === undefined) {
    const now = new Date(nowMs)
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    return { startMs, endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) }
  }
  const anchor = new Date(anchorMs)
  const day = anchor.getUTCDate()
  const hh = anchor.getUTCHours()
  const mm = anchor.getUTCMinutes()
  const ss = anchor.getUTCSeconds()
  const ms = anchor.getUTCMilliseconds()
  const anchorMonth = (year: number, month: number) => {
    const max = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return Date.UTC(year, month, Math.min(day, max), hh, mm, ss, ms)
  }
  const now = new Date(nowMs)
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()
  let startMs = anchorMonth(year, month)
  if (startMs > nowMs) {
    ;[year, month] = shiftMonth(year, month, -1)
    startMs = anchorMonth(year, month)
  }
  const [nextYear, nextMonth] = shiftMonth(year, month, 1)
  return { startMs, endMs: anchorMonth(nextYear, nextMonth) }
}

const rollingResetAt = (rows: MessageCost[], nowMs: number) =>
  Math.min(...rows.filter((row) => row.createdMs >= nowMs - FIVE_HOURS_MS && row.createdMs < nowMs).map((row) => row.createdMs), nowMs) +
  FIVE_HOURS_MS

const lastUsedAt = (rows: MessageCost[]) => {
  const latest = Math.max(...rows.map((row) => row.createdMs))
  return Number.isFinite(latest) ? latest : undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Ad-hoc, idempotent performance index — not run through the shared migration
    // system, so it can't conflict with upstream migrations. SQLite expression
    // indexes let this WHERE filter skip non-matching rows without parsing their
    // (potentially large) JSON payload.
    yield* db
      .run(sql`CREATE INDEX IF NOT EXISTS idx_message_provider_id ON message (json_extract(data, '$.providerID'))`)
      .pipe(Effect.orDie)

    const rows = Effect.fn("SessionUsage.rows")(function* (sinceMs: number) {
      return yield* db
        .all<{ id: string; cost: number | null; createdMs: number }>(
          sql`
            SELECT id, json_extract(data,'$.cost') as cost, json_extract(data,'$.time.created') as createdMs
            FROM message
            WHERE json_extract(data,'$.providerID') = ${GO_PROVIDER_ID}
              AND json_extract(data,'$.role') = 'assistant'
              AND json_extract(data,'$.time.created') >= ${sinceMs}
          `,
        )
        .pipe(
          Effect.map((result) =>
            result.map((row) => ({ messageID: row.id, cost: row.cost ?? 0, createdMs: row.createdMs })),
          ),
          Effect.orDie,
        )
    })

    const windows = Effect.fn("SessionUsage.windows")(function* () {
      const now = Date.now()

      const earliest = yield* db
        .get<{ earliest: number | null }>(
          sql`
            SELECT min(json_extract(data,'$.time.created')) as earliest
            FROM message
            WHERE json_extract(data,'$.providerID') = ${GO_PROVIDER_ID}
              AND json_extract(data,'$.role') = 'assistant'
          `,
        )
        .pipe(Effect.orDie)

      const fiveHourStart = now - FIVE_HOURS_MS
      const weekStartMs = weekStart(now)
      const month = monthBounds(now, earliest?.earliest ?? undefined)

      return [
        { label: "5h" as const, startMs: fiveHourStart, endMs: now, limitUSD: LIMITS["5h"], resetsAt: now + FIVE_HOURS_MS },
        {
          label: "week" as const,
          startMs: weekStartMs,
          endMs: weekStartMs + WEEK_MS,
          limitUSD: LIMITS.week,
          resetsAt: weekStartMs + WEEK_MS,
        },
        { label: "month" as const, startMs: month.startMs, endMs: month.endMs, limitUSD: LIMITS.month, resetsAt: month.endMs },
      ]
    })

    const goPlan = Effect.fn("SessionUsage.goPlan")(function* () {
      const bounds = yield* windows()
      const earliestStart = Math.min(...bounds.map((b) => b.startMs))
      const all = yield* rows(earliestStart)

      return bounds.map((bound) => {
        const rowsInWindow = all.filter((row) => row.createdMs >= bound.startMs && row.createdMs < bound.endMs)
        const resetAt = bound.label === "5h" ? rollingResetAt(rowsInWindow, bound.endMs) : bound.resetsAt
        const lastUsed = lastUsedAt(rowsInWindow)
        return {
          label: bound.label,
          spentUSD: rowsInWindow.reduce((total, row) => total + row.cost, 0),
          limitUSD: bound.limitUSD,
          resetsAt: resetAt,
          clearsAt: bound.label === "5h" && lastUsed !== undefined ? lastUsed + FIVE_HOURS_MS : resetAt,
          lastUsedAt: lastUsed,
          callsInWindow: rowsInWindow.length,
        }
      })
    })

    return Service.of({ goPlan, rows, windows })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
