import { describe, expect, test } from "bun:test"

import { sortEndpoints, uptimeTone, type OpenRouterEndpoint } from "./openrouter-endpoints"

const endpoint = (provider: string, prompt: number, completion: number, uptime?: number): OpenRouterEndpoint => ({
  provider,
  providerName: provider,
  tag: `${provider}/fp8`,
  pricing: { prompt, completion, cacheRead: 0 },
  ...(uptime === undefined ? {} : { uptime }),
})

describe("sortEndpoints", () => {
  test("puts the cheapest upstream first", () => {
    // Upstreams for one model serve identical weights, so price is the only
    // thing that distinguishes them for the user.
    const sorted = sortEndpoints([endpoint("dear", 3, 6), endpoint("cheap", 1, 2), endpoint("mid", 2, 3)])
    expect(sorted.map((e) => e.provider)).toEqual(["cheap", "mid", "dear"])
  })

  test("breaks a price tie on uptime, then on name", () => {
    const sorted = sortEndpoints([
      endpoint("b-low", 1, 1, 90),
      endpoint("a-none", 1, 1),
      endpoint("c-high", 1, 1, 99.9),
    ])
    expect(sorted.map((e) => e.provider)).toEqual(["c-high", "b-low", "a-none"])
  })

  test("does not mutate its input", () => {
    const input = [endpoint("dear", 3, 6), endpoint("cheap", 1, 2)]
    sortEndpoints(input)
    expect(input.map((e) => e.provider)).toEqual(["dear", "cheap"])
  })
})

describe("uptimeTone", () => {
  test("matches the desktop's thresholds", () => {
    expect(uptimeTone(99)).toBe("success")
    expect(uptimeTone(98.9)).toBe("warning")
    expect(uptimeTone(95)).toBe("warning")
    expect(uptimeTone(94.9)).toBe("danger")
  })
})
