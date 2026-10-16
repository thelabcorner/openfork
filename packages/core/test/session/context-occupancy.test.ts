import { describe, expect, test } from "bun:test"
import { ContextOccupancy } from "../../src/session/context-occupancy"
import * as SchemaContextOccupancy from "@opencode-ai/schema/context-occupancy"

const history: ContextOccupancy.ContextInput["history"] = {
  latest: {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "model-x",
    modelName: "Model X",
    contextLimit: 100,
    completedAt: 100,
    tokens: { input: 10, output: 2, reasoning: 3, cacheRead: 20, cacheWrite: 5 },
  },
}

describe("core Session context occupancy projection", () => {
  test("keeps the Schema package a shape-only owner, never a competing projector", () => {
    expect("project" in SchemaContextOccupancy).toBe(false)
    expect(typeof ContextOccupancy.project).toBe("function")
  })

  test("uses the latest provider-reported settled telemetry without summing historical requests", () => {
    const result = ContextOccupancy.project({
      history,
      telemetry: {
        updatedAt: 200,
        context: {
          model: { providerID: "anthropic", modelID: "model-y", name: "Model Y", contextLimit: 400 },
          tokens: { input: 25, output: 5, reasoning: 10, cache: { read: 90, write: 20 } },
        },
      },
    })
    expect(result).toEqual({
      providerLabel: "anthropic",
      modelLabel: "Model Y",
      total: 150,
      limit: 400,
      usage: 38,
      updatedAt: 200,
    })
  })

  test("uses only the indexed settled-generation fallback when telemetry is absent", () => {
    const result = ContextOccupancy.project({ history })
    expect(result).toEqual({
      providerLabel: "OpenAI",
      modelLabel: "Model X",
      total: 40,
      limit: 100,
      usage: 40,
      updatedAt: 100,
    })
  })

  test("is honest about unknown context limits and missing settled generations", () => {
    expect(ContextOccupancy.project(undefined)).toBeUndefined()
    expect(ContextOccupancy.project({ history: {} })).toBeUndefined()
    const missingLimit = ContextOccupancy.project({
      history: {
        latest: { ...history.latest!, contextLimit: undefined },
      },
    })
    expect(missingLimit?.total).toBe(40)
    expect(missingLimit?.usage).toBeNull()
  })
})
