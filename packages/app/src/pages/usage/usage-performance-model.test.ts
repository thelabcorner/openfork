import { describe, expect, test } from "bun:test"
import {
  averageMeasured,
  outputThroughput,
  performanceModels,
  performanceScope,
} from "./usage-performance-model"

const tokens = (input: number, cacheRead: number, output: number, reasoning = 0) =>
  ({ input, cacheRead, cacheWrite: 0, output, reasoning })

describe("usage performance projection", () => {
  test("only merges variants sharing the same provider AND model", () => {
    const models = performanceModels({
      models: [
        { providerID: "A", modelID: "X", variant: null, messages: 3, generationRecords: 2, generationMs: 2000, durationRecords: 3, durationMs: 5000, tokens: tokens(10, 5, 20) },
        { providerID: "A", modelID: "X", variant: "high", messages: 4, generationRecords: 4, generationMs: 3000, durationRecords: 4, durationMs: 8000, tokens: tokens(20, 15, 30) },
        { providerID: "B", modelID: "X", variant: null, messages: 5, generationRecords: 1, generationMs: 8000, durationRecords: 5, durationMs: 13000, tokens: tokens(10, 0, 40) },
      ],
    } as any)
    expect(models).toHaveLength(2)
    expect(models.find((row) => row.providerID === "A")).toMatchObject({
      generations: 7, measuredGenerations: 6, generationMs: 5000, output: 50, cacheRead: 20,
    })
    expect(models.find((row) => row.providerID === "B")?.generationMs).toBe(8000)
  })

  test("preserves absent coverage as undefined, not falsely zero latency", () => {
    const scope = performanceScope([{
      providerID: "A", generations: 10, measuredGenerations: 0, generationMs: 0,
      wallMs: 0, wallRecords: 0, input: 5, cacheRead: 0, output: 10, reasoning: 0,
    }])
    expect(scope.covered).toBe(false)
    expect(averageMeasured(scope.generationMs, scope.measuredGenerations)).toBeUndefined()
    expect(outputThroughput({ ...scope, providerID: "A" })).toBeUndefined()
  })

  test("requires a measured positive generation interval for throughput", () => {
    expect(outputThroughput({
      providerID: "p", generations: 1, measuredGenerations: 1, generationMs: 1000,
      wallMs: 1000, wallRecords: 1, input: 20, cacheRead: 0, output: 50, reasoning: 20,
    })).toBe(70)
  })
})
