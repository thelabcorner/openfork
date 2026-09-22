import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  scheduledCalendarDays,
  scheduledCalendarWindow,
  scheduledLocalDayKey,
  scheduledMonthGrid,
  scheduledRunAttentionRank,
  scheduledTemporalClusters,
  shiftScheduledCalendarAnchor,
} from "./scheduled-page-model"

describe("scheduled calendar model", () => {
  const anchor = new Date(2026, 8, 19, 14, 30).getTime()

  test("D19: every visible range is one bounded <=32-day agenda window", () => {
    for (const range of ["day", "week", "month"] as const) {
      const window = scheduledCalendarWindow(range, anchor)
      expect(window.to).toBeGreaterThan(window.from)
      expect(window.to - window.from).toBeLessThanOrEqual(32 * 24 * 60 * 60 * 1_000)
    }
    expect(scheduledCalendarDays(scheduledCalendarWindow("day", anchor))).toHaveLength(1)
    expect(scheduledCalendarDays(scheduledCalendarWindow("week", anchor))).toHaveLength(7)
    expect(scheduledCalendarDays(scheduledCalendarWindow("month", anchor))).toHaveLength(30)
  })

  test("D19: the workspace owns one agenda consumer and never fans out task previews", () => {
    const page = readFileSync(new URL("./scheduled-page.tsx", import.meta.url), "utf8")
    const store = readFileSync(new URL("../context/scheduled-tasks.ts", import.meta.url), "utf8")

    expect(page.match(/store\.loadAgenda\(/g) ?? []).toHaveLength(1)
    expect(page).not.toContain("store.preview(")
    expect(store.match(/\.agenda\(/g) ?? []).toHaveLength(1)
    expect(store).toContain("agendaInflight")
    expect(store).toContain("agendaCache")
  })

  test("quota resets consume one bounded Tier-0 agenda and never recreate provider fanout in the calendar", () => {
    const page = readFileSync(new URL("./scheduled-page.tsx", import.meta.url), "utf8")
    const resets = readFileSync(new URL("./scheduled-quota-resets.ts", import.meta.url), "utf8")

    expect(page.match(/quotaResets\.load\(/g) ?? []).toHaveLength(1)
    expect(resets.match(/\.client\.quota\.resets\(/g) ?? []).toHaveLength(1)
    expect(page).not.toContain("useLimits(")
    expect(resets).not.toContain(".client.quota.get(")
    expect(resets).not.toContain(".client.quota.providers(")
    expect(resets).not.toContain("setInterval(")
    expect(resets).toContain("MAX_CACHE_ENTRIES = 6")
    expect(resets).toContain("if (state.key !== key) return")
  })

  test("T10.10: workspace open is catalog/history-free, 30d rendering is bounded, and countdowns share one ticker", () => {
    const page = readFileSync(new URL("./scheduled-page.tsx", import.meta.url), "utf8")
    const editor = readFileSync(new URL("../components/scheduled-task-editor.tsx", import.meta.url), "utf8")
    const store = readFileSync(new URL("../context/scheduled-tasks.ts", import.meta.url), "utf8")

    // The workspace renders durable Model.Ref fields directly. Catalog access is
    // editor-owned and therefore cannot become a page-open request fanout.
    expect(page).not.toContain("useLocal(")
    expect(page).not.toContain("ModelSelectorPopoverV2")
    expect(editor).toContain("ModelSelectorPopoverV2")

    // Existing-Session selection uses one compact Scheduled projection, never
    // Session message/history hydration or per-row Session fetches.
    expect(editor.match(/store\.sessionCandidates\(/g) ?? []).toHaveLength(1)
    expect(editor).not.toMatch(/sdk\(\)\.client\.session/)

    // Thirty-day mode renders at most four chips per day; the agenda itself is
    // bounded at 5k rows and activity hydration at 200 runs.
    expect(page).toContain("events().slice(0, 4)")
    expect(store).toContain('limit: "5000"')
    expect(store).toContain('inbox({ limit: "200" }')

    // Countdown ownership is store-global, not per task/event row.
    expect(page).not.toContain("setInterval(")
    expect(store.match(/setInterval\(/g) ?? []).toHaveLength(1)
  })

  test("scheduled workspace follows the raised-pane shell and shared scrollbar contract", () => {
    const page = readFileSync(new URL("./scheduled-page.tsx", import.meta.url), "utf8")

    expect(page).toContain('data-component="scheduled-tasks-page"')
    expect(page).toContain(
      'class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"',
    )
    expect(page).not.toContain('class="flex h-full min-h-0 w-full flex-col')
    expect(page).not.toMatch(/class="[^"]*\boverflow-auto\b[^"]*"/)
    expect(page).not.toMatch(/class="[^"]*\boverflow-y-auto\b[^"]*"/)
    expect(page.match(/<ScrollView(?:\s|>)/g) ?? []).toHaveLength(4)
    expect(page.match(/<ScrollViewOverlayScrollbar/g) ?? []).toHaveLength(2)
    expect(page.match(/orientation="horizontal"/g) ?? []).toHaveLength(2)
  })

  test("range navigation advances by the semantic calendar unit", () => {
    const day = shiftScheduledCalendarAnchor("day", anchor, 1)
    const week = shiftScheduledCalendarAnchor("week", anchor, 1)
    const month = shiftScheduledCalendarAnchor("month", anchor, 1)
    expect(scheduledLocalDayKey(day)).toBe(scheduledLocalDayKey(new Date(2026, 8, 20).getTime()))
    expect(scheduledLocalDayKey(week)).toBe(scheduledLocalDayKey(new Date(2026, 8, 26).getTime()))
    expect(scheduledLocalDayKey(month)).toBe(scheduledLocalDayKey(new Date(2026, 9, 19).getTime()))
  })

  test("month grid is week-aligned without widening the agenda query", () => {
    const cells = scheduledMonthGrid(anchor)
    expect(cells.length % 7).toBe(0)
    expect(cells.filter((value) => value !== undefined)).toHaveLength(30)
    expect(scheduledLocalDayKey(cells.find((value) => value !== undefined)!)).toBe(scheduledLocalDayKey(anchor))
  })

  test("reset rail clustering preserves every authoritative event while preventing adjacent rail collisions", () => {
    const base = new Date(2026, 8, 19, 9, 0).getTime()
    const input = [
      { id: "later", at: base + 17 * 60_000 },
      { id: "first", at: base },
      { id: "near", at: base + 8 * 60_000 },
      { id: "separate", at: base + 40 * 60_000 },
    ]
    const clusters = scheduledTemporalClusters(input, (item) => item.at, 18 * 60_000)

    expect(clusters).toHaveLength(2)
    expect(clusters[0]?.items.map((item) => item.id)).toEqual(["first", "near", "later"])
    expect(clusters[0]?.startAt).toBe(base)
    expect(clusters[0]?.endAt).toBe(base + 17 * 60_000)
    expect(clusters[1]?.items.map((item) => item.id)).toEqual(["separate"])
    expect(input.map((item) => item.id)).toEqual(["later", "first", "near", "separate"])
  })

  test("temporal clustering is deterministic at the threshold and discards invalid presentation timestamps", () => {
    const base = new Date(2026, 8, 19, 9, 0).getTime()
    const input = [
      { id: "invalid", at: Number.NaN },
      { id: "a", at: base },
      { id: "threshold", at: base + 18 * 60_000 },
      { id: "outside", at: base + 36 * 60_000 + 1 },
    ]

    const clusters = scheduledTemporalClusters(input, (item) => item.at, 18 * 60_000)
    expect(clusters.map((cluster) => cluster.items.map((item) => item.id))).toEqual([["a", "threshold"], ["outside"]])
    expect(clusters.flatMap((cluster) => cluster.items).some((item) => item.id === "invalid")).toBe(false)
  })

  test("timed reset rendering reserves an independent system rail instead of z-indexing over task controls", () => {
    const page = readFileSync(new URL("./scheduled-page.tsx", import.meta.url), "utf8")

    expect(page).toContain("SYSTEM_EVENT_RAIL_WIDTH")
    expect(page).toContain("scheduledTemporalClusters")
    expect(page).toContain('data-calendar-layer="system-event-rail"')
    expect(page).toContain('data-calendar-layer="quota-reset-guide"')
    expect(page).toContain('data-calendar-layer="quota-reset-marker"')
    expect(page).toContain('data-calendar-layer="scheduled-task"')
    expect(page).toContain('right: props.showSystemEvents ? `${SYSTEM_EVENT_RAIL_WIDTH + 4}px` : "4px"')
    expect(page).not.toContain("z-[15]")
  })

  test("activity ranking keeps waiting/failed unread work ahead of passive history", () => {
    expect(scheduledRunAttentionRank({ status: "waiting", unread: true })).toBeLessThan(
      scheduledRunAttentionRank({ status: "running", unread: false }),
    )
    expect(scheduledRunAttentionRank({ status: "failed", unread: true })).toBeLessThan(
      scheduledRunAttentionRank({ status: "succeeded", unread: false }),
    )
  })
})
