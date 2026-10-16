import { describe, expect, test } from "bun:test"
import { OxpAttributionModel as Model, type Row } from "@opencode-ai/core/oxp-attribution/model"
import { Rollup } from "@opencode-ai/core/oxp-attribution/rollup"
import { OxpAttributionRevision } from "@opencode-ai/core/oxp-attribution/revision"
import type { Coverage } from "@opencode-ai/core/oxp-attribution/attribution"

const options: Model.ProjectOptions = {
  turnGapThresholdMs: 100,
  requestCharsPerToken: 3.4,
  resultCharsPerToken: 3.8,
  upstream: {
    coefficients: [7, 0.6, 0.15, 0.1, 0.12, 0.14, 0.08, 0.05],
    means: [0, 1, 2, 3, 4, 5, 6, 7],
    stds: [1, 2, 3, 4, 5, 6, 7, 8],
  },
}

const covered = (rows: readonly Row[]): Coverage => ({
  request: {
    observed_boundary: rows.length, historical_detail: 0, calibrated_surrogate: 0, calibrated_donor: 0, unavailable: 0,
  },
  result: {
    observed_boundary: rows.length, historical_detail: 0, calibrated_surrogate: 0, calibrated_donor: 0,
    unavailable: 0, not_applicable: 0,
  },
  invalidPersistedMeasurements: 0,
  complete: true,
})

const mass = (chars: number) => ({ chars, source: "observed_boundary" as const })

const activityRows = (activityID: string, calls: number, seed: number): Row[] =>
  Array.from({ length: calls }, (_, i) => ({
    id: `${activityID}-${seed}-${i}`,
    activityID,
    tool: ["read", "git", "process"][i % 3]!,
    status: "success",
    startedAt: i * 150 + (i % 4) * 30,
    completedAt: i * 150 + (i % 4) * 30 + 10,
    request: mass((seed + 3 * i) % 250 + 1),
    result: mass((seed * 2 + 7 * i) % 400 + 1),
  }))

describe("OXP attribution incremental rollup", () => {
  test("matches the canonical full-history model across activity mutations and deletions", () => {
    const rollup = new Rollup()
    const histories = new Map<string, Row[]>()

    const update = (id: string, rows?: Row[]) => {
      if (!rows) {
        histories.delete(id)
        rollup.update(id)
      } else {
        histories.set(id, rows)
        rollup.update(id, { totals: Model.project(rows, options), coverage: covered(rows) })
      }
      const expected = Model.project([...histories.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, value]) => value), options)
      const actual = rollup.snapshot(options)
      expect(actual.totals.calls).toBe(expected.calls)
      expect(actual.totals.activities).toBe(expected.activities)
      expect(actual.totals.inferredTurns).toBe(expected.inferredTurns)
      expect(actual.totals.requestChars).toBe(expected.requestChars)
      expect(actual.totals.resultChars).toBe(expected.resultChars)
      expect(actual.totals.tokens).toBeCloseTo(expected.tokens, 8)
      expect(actual.totals.estimatedTotalTokens).toBeCloseTo(expected.estimatedTotalTokens, 8)
      expect(actual.totals.estimatedSurroundingTokens).toBeCloseTo(expected.estimatedSurroundingTokens, 8)
      expect([...actual.totals.byTool].sort((a, b) => a.tool.localeCompare(b.tool))).toEqual(
        [...expected.byTool].sort((a, b) => a.tool.localeCompare(b.tool)),
      )
      expect(actual.coverage.request.observed_boundary).toBe(expected.calls)
      expect(actual.coverage.result.observed_boundary).toBe(expected.calls)
      expect(actual.coverage.complete).toBe(true)
    }

    for (let i = 0; i < 50; i++) update(`activity-${String(i).padStart(3, "0")}`, activityRows(`activity-${String(i).padStart(3, "0")}`, i % 9 + 1, i + 1))
    // Rewrite old activity contributions after newer ones exist: a settlement
    // may extend a turn interval, changing the empirical regression output.
    for (let i = 0; i < 50; i += 3) {
      const id = `activity-${String(i).padStart(3, "0")}`
      update(id, activityRows(id, 1 + (i % 9), i + 17))
    }
    for (let i = 0; i < 50; i += 4) update(`activity-${String(i).padStart(3, "0")}`)
  })

  test("journals only producer-identified activities and fails closed on unknown writes", () => {
    const initial = OxpAttributionRevision.current()
    OxpAttributionRevision.advance("a")
    OxpAttributionRevision.advance(["a", "b"])
    expect([...OxpAttributionRevision.changedSince(initial)!].sort()).toEqual(["a", "b"])
    const known = OxpAttributionRevision.current()
    OxpAttributionRevision.advance()
    expect(OxpAttributionRevision.changedSince(known)).toBeUndefined()
    expect(OxpAttributionRevision.changedSince(OxpAttributionRevision.current())).toEqual(new Set())
  })

  test("ring journal preserves exactly its bounded history across wraparound", () => {
    const start = OxpAttributionRevision.current()
    for (let i = 0; i < 2048; i++) OxpAttributionRevision.advance(`ring-${i}`)
    expect(OxpAttributionRevision.changedSince(start)?.size).toBe(2048)
    OxpAttributionRevision.advance("ring-overwrite")
    expect(OxpAttributionRevision.changedSince(start)).toBeUndefined()
    const surviving = OxpAttributionRevision.changedSince(start + 1)
    expect(surviving?.size).toBe(2048)
    expect(surviving?.has("ring-0")).toBe(false)
    expect(surviving?.has("ring-1")).toBe(true)
    expect(surviving?.has("ring-overwrite")).toBe(true)
    expect(OxpAttributionRevision.changedSince(-1)).toBeUndefined()
    expect(OxpAttributionRevision.changedSince(OxpAttributionRevision.current() + 1)).toBeUndefined()
  })
})