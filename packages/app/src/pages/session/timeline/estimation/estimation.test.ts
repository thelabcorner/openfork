import { describe, expect, it } from "bun:test"
import { TimelineRow } from "../timeline-row"
import { estimateRowSize, TIMELINE_FALLBACK_SIZE, type RowEstimateInput } from "./estimate-row-size"
import { isEligibleText, rowTextKind } from "./eligibility"
import { contentHash, MeasurementHistory, widthBucket, WIDTH_BUCKET_PX } from "./measurement-history"
import { RowTypePriors } from "./priors"
import { TimelineRowEstimator, TIMELINE_TYPOGRAPHY } from "./index"

const row = (overrides: Partial<RowEstimateInput["row"]> = {}) =>
  new TimelineRow.TurnGap({ userMessageID: "m1", ...overrides }) as unknown as RowEstimateInput["row"]

const input = (overrides: Partial<RowEstimateInput> = {}): RowEstimateInput => ({
  key: "k1",
  row: row(),
  ...overrides,
})

const emptyContext = {
  measured: () => undefined,
  history: () => undefined,
  fixed: () => undefined,
  pretext: () => undefined,
  prior: () => undefined,
  widthPx: () => 640,
  fallback: TIMELINE_FALLBACK_SIZE,
}

describe("estimateRowSize priority chain", () => {
  it("falls back when nothing stronger exists", () => {
    const result = estimateRowSize(input(), emptyContext)
    expect(result.source).toBe("fallback")
    expect(result.size).toBe(TIMELINE_FALLBACK_SIZE)
  })

  it("prefers current measurement over everything", () => {
    const result = estimateRowSize(input(), {
      ...emptyContext,
      measured: () => 123,
      history: () => 200,
      fixed: () => 24,
      pretext: () => 150,
      prior: () => 100,
    })
    expect(result.source).toBe("measured")
    expect(result.size).toBe(123)
  })

  it("uses history before fixed/pretext/prior", () => {
    const result = estimateRowSize(input(), {
      ...emptyContext,
      history: () => 200,
      fixed: () => 24,
      pretext: () => 150,
      prior: () => 100,
    })
    expect(result.source).toBe("history")
    expect(result.size).toBe(200)
  })

  it("uses deterministic fixed height for known-fixed rows", () => {
    const result = estimateRowSize(input(), {
      ...emptyContext,
      fixed: () => 24,
      pretext: () => 150,
      prior: () => 100,
    })
    expect(result.source).toBe("fixed")
    expect(result.size).toBe(24)
  })

  it("uses pretext before the row-type prior", () => {
    const result = estimateRowSize(
      input({ text: "plain text" }),
      {
        ...emptyContext,
        pretext: () => 150,
        prior: () => 100,
      },
    )
    expect(result.source).toBe("pretext")
    expect(result.size).toBe(150)
  })

  it("skips pretext for streaming rows", () => {
    const result = estimateRowSize(input({ text: "plain text", streaming: true }), {
      ...emptyContext,
      pretext: () => 150,
      prior: () => 100,
    })
    expect(result.source).toBe("prior")
  })

  it("uses the row-type prior as the last resort", () => {
    const result = estimateRowSize(input(), {
      ...emptyContext,
      prior: () => 88,
    })
    expect(result.source).toBe("prior")
    expect(result.size).toBe(88)
  })

  it("delegates fixed heights for TurnGap", () => {
    expect(TimelineRowEstimator["prototype"]).toBeDefined()
    const result = estimateRowSize(
      input({ row: new TimelineRow.TurnGap({ userMessageID: "m1" }) }),
      {
        ...emptyContext,
        fixed: (r) => (r._tag === "TurnGap" ? 24 : undefined),
      },
    )
    expect(result).toEqual({ size: 24, source: "fixed" })
  })
})

describe("eligibility", () => {
  it("accepts plain prose", () => {
    expect(isEligibleText("hello world, this is a plain sentence")).toBe(true)
  })

  it("rejects tabs (tab-size mismatch)", () => {
    expect(isEligibleText("a\tb")).toBe(false)
  })

  it("rejects complex markdown", () => {
    expect(isEligibleText("```ts\nconst x = 1\n```")).toBe(false)
    expect(isEligibleText("| a | b |\n| --- | --- |")).toBe(false)
    expect(isEligibleText("$$math$$")).toBe(false)
    expect(isEligibleText("![alt](url)")).toBe(false)
    expect(isEligibleText("# heading")).toBe(false)
    expect(isEligibleText("> quote")).toBe(false)
    expect(isEligibleText("    indented code")).toBe(false)
  })

  it("rejects oversized text", () => {
    expect(isEligibleText("x".repeat(32_001))).toBe(false)
  })

  it("rejects empty text", () => {
    expect(isEligibleText("")).toBe(false)
  })

  it("classifies row text kinds", () => {
    expect(rowTextKind(new TimelineRow.Error({ userMessageID: "m1", text: "boom" }))).toEqual({
      kind: "error-text",
      text: "boom",
    })
    expect(rowTextKind(new TimelineRow.TurnGap({ userMessageID: "m1" }))).toEqual({ kind: "none" })
  })
})

describe("measurement history", () => {
  it("buckets widths and returns the average for matching content", () => {
    const history = new MeasurementHistory()
    const text = "some stable text"
    history.observe("AssistantPart", text, 640, 100)
    history.observe("AssistantPart", text, 680, 120)
    const result = history.get("AssistantPart", text, 660)
    expect(result).toBe(110)
  })

  it("returns undefined for unknown content", () => {
    const history = new MeasurementHistory()
    expect(history.get("AssistantPart", "other text", 640)).toBeUndefined()
  })

  it("hashes content width-free", () => {
    expect(contentHash("a")).toBe(contentHash("a"))
    expect(contentHash("a")).not.toBe(contentHash("b"))
    expect(widthBucket(640)).toBe(Math.floor(640 / WIDTH_BUCKET_PX))
  })
})

describe("row-type priors", () => {
  it("starts empty and learns from observations", () => {
    const priors = new RowTypePriors()
    expect(priors.get("AssistantPart")).toBeUndefined()
    priors.observe("AssistantPart", 100)
    priors.observe("AssistantPart", 120)
    const value = priors.get("AssistantPart")!
    expect(value).toBeGreaterThan(100)
    expect(value).toBeLessThan(120)
  })

  it("ignores invalid heights", () => {
    const priors = new RowTypePriors()
    priors.observe("AssistantPart", Number.NaN)
    priors.observe("AssistantPart", 0)
    expect(priors.sampleCount("AssistantPart")).toBe(0)
  })
})

describe("TimelineRowEstimator", () => {
  it("returns the fallback by default (no measurements)", () => {
    const estimator = new TimelineRowEstimator({ mode: "off" })
    const assistantRow = new TimelineRow.AssistantPart({
      userMessageID: "m1",
      group: { type: "part", ref: { messageID: "msg", partID: "part" }, key: "g" } as never,
      previousAssistantPart: false,
    })
    expect(estimator.estimateSize(input({ row: assistantRow }))).toBe(TIMELINE_FALLBACK_SIZE)
  })

  it("never downgrades a real measurement", () => {
    const estimator = new TimelineRowEstimator({ mode: "pretext" })
    estimator.setWidth(640)
    estimator.observe({ key: "k1", row: row(), text: "hello world", height: 200 })
    const result = estimator.estimateSize(input({ text: "hello world" }))
    expect(result).toBe(200)
  })

  it("is monotonic: measurement beats pretext and prior", () => {
    const estimator = new TimelineRowEstimator({ mode: "pretext", instrument: true })
    estimator.setWidth(640)
    const estimated = estimator.estimateSize(input({ text: "short" }))
    expect(estimated).toBeGreaterThan(0)
    estimator.observe({ key: "k1", row: row(), text: "short", height: 42 })
    expect(estimator.estimateSize(input({ text: "short" }))).toBe(42)
    expect(estimator.recordFor("k1")?.source).toBe("measured")
  })

  it("feeds priors and history from observations", () => {
    const estimator = new TimelineRowEstimator({ mode: "prior" })
    estimator.setWidth(640)
    const assistantRow = new TimelineRow.AssistantPart({
      userMessageID: "m1",
      group: { type: "part", ref: { messageID: "msg", partID: "part" }, key: "g" } as never,
      previousAssistantPart: false,
    })
    estimator.observe({ key: "k1", row: assistantRow, text: "content", height: 100 })
    estimator.observe({ key: "k2", row: assistantRow, text: "content", height: 140 })
    // mode prior: no pretext, so a fresh row of the same type uses the prior.
    const prior = estimator.estimateSize(
      input({ key: "k3", row: assistantRow, text: "content" }),
    )
    expect(prior).toBeGreaterThan(100)
    expect(prior).toBeLessThan(140)
  })

  it("pretext mode estimates eligible text", async () => {
    await import("@chenglou/pretext")
    const estimator = new TimelineRowEstimator({ mode: "pretext" })
    estimator.setWidth(640)
    const size = estimator.estimateSize(input({ text: "The quick brown fox jumps over the lazy dog" }))
    expect(size).toBeGreaterThan(TIMELINE_TYPOGRAPHY.lineHeightPx)
  })
})
