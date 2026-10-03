import { describe, expect, test } from "bun:test"
import { OxpAttributionModel as Model, type Row } from "@opencode-ai/core/oxp-attribution/model"

const source = "historical_detail" as const

const options = (rho: number) => ({
  rho,
  gapThresholdMs: 100,
  requestCharsPerToken: 1,
  resultCharsPerToken: 1,
})

function reference(rows: readonly Row[], rho: number) {
  const byActivity = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = byActivity.get(row.activityID)
    if (bucket) bucket.push(row)
    else byActivity.set(row.activityID, [row])
  }
  let request = 0
  let result = 0
  for (const activityRows of byActivity.values()) {
    const clusters: Array<{ end: number; request: number; result: number }> = []
    for (const row of [...activityRows].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))) {
      const end = row.completedAt ?? row.startedAt
      let cluster = clusters.at(-1)
      if (!cluster || row.startedAt > cluster.end + 100) {
        cluster = { end, request: 0, result: 0 }
        clusters.push(cluster)
      } else {
        cluster.end = Math.max(cluster.end, end)
      }
      cluster.request += row.request?.chars ?? 0
      cluster.result += row.result?.chars ?? 0
    }
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[index]!
      const remaining = clusters.length - index
      for (let age = 0; age < remaining; age++) {
        const weight = rho ** age
        request += cluster.request * weight
        result += cluster.result * weight
      }
    }
  }
  return { request, result }
}

const rows: Row[] = [
  {
    id: "1",
    activityID: "a",
    tool: "read",
    status: "success",
    startedAt: 0,
    completedAt: 10,
    request: { chars: 100, source },
    result: { chars: 900, source },
  },
  {
    id: "2",
    activityID: "a",
    tool: "git",
    status: "success",
    startedAt: 5_000,
    completedAt: 5_010,
    request: { chars: 50, source },
    result: { chars: 50, source },
  },
  {
    id: "3",
    activityID: "a",
    tool: "read",
    status: "success",
    startedAt: 10_000,
    completedAt: 10_010,
    request: { chars: 100, source },
    result: { chars: 100, source },
  },
  {
    id: "4",
    activityID: "b",
    tool: "find",
    status: "success",
    startedAt: 20_000,
    completedAt: 20_020,
    request: { chars: 25, source },
    result: { chars: 75, source },
  },
]

describe("OxpAttributionModel", () => {
  for (const rho of [0, 0.25, 0.9, 0.99, 0.999999999, 1]) {
    test(`matches direct geometric exposure at rho=${rho}`, () => {
      const actual = Model.project(rows, options(rho))
      const expected = reference(rows, rho)
      expect(actual.requestChars).toBeCloseTo(expected.request, 10)
      expect(actual.resultChars).toBeCloseTo(expected.result, 10)
      expect(actual.byTool.reduce((sum, row) => sum + row.requestChars, 0)).toBeCloseTo(actual.requestChars, 10)
      expect(actual.bySource.reduce((sum, row) => sum + row.resultChars, 0)).toBeCloseTo(actual.resultChars, 10)
    })
  }

  test("rho zero is the one-copy footprint", () => {
    const actual = Model.project(rows, options(0))
    expect(actual.chars).toBe(actual.uniqueChars)
    expect(actual.amplification).toBe(1)
  })

  test("isolates activities from each other's decay", () => {
    const together = Model.project(rows, options(0.9))
    const a = Model.project(
      rows.filter((row) => row.activityID === "a"),
      options(0.9),
    )
    const b = Model.project(
      rows.filter((row) => row.activityID === "b"),
      options(0.9),
    )
    expect(together.chars).toBeCloseTo(a.chars + b.chars, 10)
  })

  test("totals-only sensitivity path is exactly the rich total", () => {
    for (const rho of [0, 0.25, 0.9, 0.99, 1]) {
      expect(Model.projectTokenTotal(rows, options(rho))).toBeCloseTo(
        Model.project(rows, options(rho)).tokens,
        10,
      )
    }
  })

  test("rejects corrupt mass instead of poisoning a snapshot", () => {
    expect(() =>
      Model.project(
        [
          {
            ...rows[0]!,
            request: { chars: Number.NaN, source },
          },
        ],
        options(0.9),
      ),
    ).toThrow("request mass")
    expect(() =>
      Model.project(
        [
          {
            ...rows[0]!,
            result: { chars: -1, source },
          },
        ],
        options(0.9),
      ),
    ).toThrow("result mass")
  })

  test("rejects interleaved activity runs instead of silently mis-clustering", () => {
    expect(() => Model.project([rows[0]!, rows[3]!, rows[1]!], options(0.9))).toThrow("grouped by activity")
  })
})
