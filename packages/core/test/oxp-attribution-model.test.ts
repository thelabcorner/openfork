import { describe, expect, test } from "bun:test"
import { OxpAttributionModel as Model, type Row } from "@opencode-ai/core/oxp-attribution/model"

const source = "historical_detail" as const

const options = {
  turnGapThresholdMs: 100,
  requestCharsPerToken: 1,
  resultCharsPerToken: 1,
  upstream: {
    coefficients: [Math.log1p(1_000), 0, 0, 0, 0, 0, 0, 0],
    means: [0, 0, 0, 0, 0, 0, 0, 0],
    stds: [1, 1, 1, 1, 1, 1, 1, 1],
  },
} satisfies Model.ProjectOptions

const rows: Row[] = [
  {
    id: "1",
    activityID: "a",
    tool: "read",
    status: "success",
    startedAt: 0,
    completedAt: 10,
    request: { chars: 100, source },
    result: { chars: 300, source },
  },
  {
    id: "2",
    activityID: "a",
    tool: "git",
    status: "success",
    startedAt: 50,
    completedAt: 60,
    request: { chars: 50, source },
    result: { chars: 50, source },
  },
  {
    id: "3",
    activityID: "a",
    tool: "read",
    status: "success",
    startedAt: 1_000,
    completedAt: 1_010,
    request: { chars: 10, source },
    result: { chars: 20, source },
  },
]

describe("OXP attribution model", () => {
  test("regression matches the independently expanded eight-feature formula", () => {
    const calibrated: Model.ProjectOptions = {
      ...options,
      requestCharsPerToken: 2,
      resultCharsPerToken: 3,
      upstream: {
        coefficients: [6, 0.4, 0.2, 0.1, 0.3, 0.2, 0.05, 0.12],
        means: [0, 1, 2, 3, 4, 5, 6, 7],
        stds: [1, 2, 3, 4, 5, 6, 7, 8],
      },
    }
    const direct = 20 / 2 + 51 / 3
    const features = [1, Math.log1p(10), Math.log1p(17), Math.log1p(1), Math.log1p(direct), Math.log1p(1), Math.log1p(1), Math.log1p(10)]
    let logEstimate = 0
    for (let index = 0; index < features.length; index++) {
      const scaled = index === 0 ? features[index]! : (features[index]! - calibrated.upstream.means[index]!) / calibrated.upstream.stds[index]!
      logEstimate += scaled * calibrated.upstream.coefficients[index]!
    }
    const actual = Model.project(
      [{ id: "one", activityID: "single", tool: "read", status: "success", startedAt: 100, completedAt: 10_100, request: { chars: 20, source }, result: { chars: 51, source } }],
      calibrated,
    )
    expect(actual.estimatedTotalTokens).toBe(Math.max(direct, Math.expm1(logEstimate)))
    expect(actual.inferredTurns).toBe(1)
  })

  test("counts each observed request/result payload exactly once for OXP tokens", () => {
    const value = Model.project(rows, options)
    expect(value.requestChars).toBe(160)
    expect(value.resultChars).toBe(370)
    expect(value.chars).toBe(530)
    expect(value.requestTokens).toBe(160)
    expect(value.resultTokens).toBe(370)
    expect(value.tokens).toBe(530)
  })

  test("learned upstream estimate is separate from direct OXP payload accounting", () => {
    const value = Model.project(rows, options)
    expect(value.activities).toBe(1)
    expect(value.inferredTurns).toBe(2)
    expect(value.estimatedTotalTokens).toBeCloseTo(2_000)
    expect(value.estimatedSurroundingTokens).toBeCloseTo(1_470)
  })

  test("tool/source breakdowns remain direct payload estimates, not upstream attribution", () => {
    const value = Model.project(rows, options)
    expect(value.byTool).toEqual([
      {
        tool: "read",
        calls: 2,
        requestChars: 110,
        resultChars: 320,
        chars: 430,
        requestTokens: 110,
        resultTokens: 320,
        tokens: 430,
      },
      {
        tool: "git",
        calls: 1,
        requestChars: 50,
        resultChars: 50,
        chars: 100,
        requestTokens: 50,
        resultTokens: 50,
        tokens: 100,
      },
    ])
    expect(value.bySource).toEqual([
      {
        source,
        requestCalls: 3,
        resultCalls: 3,
        requestChars: 160,
        resultChars: 370,
        chars: 530,
        requestTokens: 160,
        resultTokens: 370,
        tokens: 530,
      },
    ])
  })

  test("resets cumulative upstream features at each OXP activity", () => {
    const input: Row[] = [
      {
        id: "1",
        activityID: "a",
        tool: "read",
        status: "success",
        startedAt: 0,
        request: { chars: 10, source },
        result: { chars: 10, source },
      },
      {
        id: "2",
        activityID: "b",
        tool: "read",
        status: "success",
        startedAt: 0,
        request: { chars: 10, source },
        result: { chars: 10, source },
      },
    ]
    const value = Model.project(input, options)
    expect(value.activities).toBe(2)
    expect(value.inferredTurns).toBe(2)
    expect(value.estimatedTotalTokens).toBeCloseTo(2_000)
  })

  test("floors upstream estimate at the direct OXP payload size", () => {
    const input: Row[] = [
      {
        id: "1",
        activityID: "a",
        tool: "read",
        status: "success",
        startedAt: 0,
        request: { chars: 2_000, source },
        result: { chars: 2_000, source },
      },
    ]
    const value = Model.project(input, options)
    expect(value.tokens).toBe(4_000)
    expect(value.estimatedTotalTokens).toBe(4_000)
    expect(value.estimatedSurroundingTokens).toBe(0)
  })

  test("rejects non-contiguous activity ordering", () => {
    const input: Row[] = [
      { id: "1", activityID: "a", tool: "read", status: "success", startedAt: 0 },
      { id: "2", activityID: "b", tool: "read", status: "success", startedAt: 1 },
      { id: "3", activityID: "a", tool: "read", status: "success", startedAt: 2 },
    ]
    expect(() => Model.project(input, options)).toThrow("grouped by activity")
  })

  test("direct OXP accounting is additive across disjoint activities", () => {
    const a: Row[] = [
      { id: "1", activityID: "a", tool: "read", status: "success", startedAt: 0, request: { chars: 10, source }, result: { chars: 20, source } },
      { id: "2", activityID: "a", tool: "read", status: "success", startedAt: 5, request: { chars: 5, source }, result: { chars: 5, source } },
    ]
    const b: Row[] = [
      { id: "3", activityID: "b", tool: "git", status: "success", startedAt: 0, request: { chars: 7, source }, result: { chars: 3, source } },
    ]
    const left = Model.project(a, options)
    const right = Model.project(b, options)
    const union = Model.project([...a, ...b], options)
    expect(union.requestChars).toBe(left.requestChars + right.requestChars)
    expect(union.resultChars).toBe(left.resultChars + right.resultChars)
    expect(union.tokens).toBe(left.tokens + right.tokens)
    expect(union.calls).toBe(left.calls + right.calls)
  })

  test("direct OXP accounting is independent of row order within an activity", () => {
    // Rows sharing a timestamp may arrive in any id order; direct accounting
    // must not depend on that tie-breaking.
    const tied: Row[] = [
      { id: "a", activityID: "a", tool: "read", status: "success", startedAt: 100, request: { chars: 10, source }, result: { chars: 20, source } },
      { id: "b", activityID: "a", tool: "git", status: "success", startedAt: 100, request: { chars: 7, source }, result: { chars: 3, source } },
    ]
    const forward = Model.project(tied, options)
    const reversed = Model.project([...tied].reverse(), options)
    expect(reversed.requestChars).toBe(forward.requestChars)
    expect(reversed.resultChars).toBe(forward.resultChars)
    expect(reversed.chars).toBe(forward.chars)
    expect(reversed.tokens).toBe(forward.tokens)
  })

  test("rejects negative character mass", () => {
    const input: Row[] = [
      { id: "1", activityID: "a", tool: "read", status: "success", startedAt: 0, request: { chars: -1, source } },
    ]
    expect(() => Model.project(input, options)).toThrow("request mass")
  })

  test("fused validation rejects malformed timestamps and out-of-order rows", () => {
    const base: Row = { id: "valid", activityID: "a", tool: "read", status: "success", startedAt: 100 }
    expect(() => Model.project([{ ...base, startedAt: Number.NaN }], options)).toThrow("startedAt")
    expect(() => Model.project([{ ...base, completedAt: 99 }], options)).toThrow("invocation geometry")
    expect(() => Model.project([{ ...base, result: { chars: Infinity, source } }], options)).toThrow("result mass")
    expect(() => Model.project([base, { ...base, id: "earlier", startedAt: 50 }], options)).toThrow("ordered by activity")
    expect(() => Model.project([{ ...base, tool: "" }], options)).toThrow("row identity")
  })

  test("golden: stable synthetic projection under frozen calibration", () => {
    const golden = Model.project(rows, options)
    expect(golden.calls).toBe(3)
    expect(golden.activities).toBe(1)
    expect(golden.inferredTurns).toBe(2)
    expect(golden.requestChars).toBe(160)
    expect(golden.resultChars).toBe(370)
    expect(golden.estimatedTotalTokens).toBeCloseTo(2_000)
    expect(golden.estimatedSurroundingTokens).toBeCloseTo(1_470)
  })
})
