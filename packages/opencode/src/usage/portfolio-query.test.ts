import { describe, expect, test } from "bun:test"
import { valuePortfolio, type PortfolioGroup } from "./portfolio-query"

const row = (variant: string | null): PortfolioGroup => ({
  provider_id: "vendor", model_id: "model", variant,
  messages: 1, recorded_cost: 0, recorded_records: 1, missing_records: 0,
  input_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0,
  output_tokens: 2, reasoning_tokens: 0,
  missing_input_tokens: 0, missing_cache_read_tokens: 0,
  missing_cache_write_tokens: 0, missing_output_tokens: 0,
  missing_reasoning_tokens: 0, duration_ms: 10, duration_records: 1,
  generation_ms: 5, generation_records: 1,
})

describe("SQL portfolio correctness gates", () => {
  test("keeps variant labels separate while recording exact provider sessions", () => {
    const result = valuePortfolio([row(null),row("high")], [{provider_id:"vendor", sessions:1}], new Map())
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]!.sessions).toBe(1)
    expect(result.models).toHaveLength(2)
    expect(result.variants.map(v=>v.variant)).toEqual([null,"high"])
    expect(result.models.every(m=>m.cost===0&&m.unpricedRecords===0)).toBe(true)
  })
  test("keeps empty-string and null variant models separate", () => {
    const result = valuePortfolio([row(null),row("")], [{provider_id:"vendor",sessions:1}], new Map())
    expect(result.models).toHaveLength(2)
    expect(result.models.map(model => model.variant)).toEqual([null,""])
    expect(result.variants.map(variant => variant.variant)).toEqual([null,""])
  })
})
