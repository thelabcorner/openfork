import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GoCapacityPrior } from "@/capacity/go-prior"

const DOC = [
  "## Usage limits",
  "",
  "| Model                                | Input | Output | Cached Read | Cached Write | Monthly limit |",
  "| ------------------------------------ | ----- | ------ | ----------- | ------------ | ------------- |",
  "| GLM-5.3                              | $1.40 | $4.40  | $0.26       | -            | **$15**       |",
  "| GLM-5.2                              | $1.40 | $4.40  | $0.26       | -            | **$60**       |",
  "| Kimi K2.6                            | $0.95 | $4.00  | $0.16       | -            | **$60**       |",
  "| GPT 5.6 Luna (≤ 272K tokens)         | $0.20 | $1.20  | $0.02       | $0.25        | **$15**       |",
  "| GPT 5.6 Luna (> 272K tokens)         | $0.40 | $1.80  | $0.04       | $0.50        | **$15**       |",
  "| DeepSeek V4.1 Flash (Off-Peak)       | $0.15 | $0.60  | $0.003      | -            | **$60**       |",
  "| DeepSeek V4.1 Flash (Peak)           | $0.30 | $1.20  | $0.006      | -            | **$60**       |",
  "",
  "### Estimated requests",
  "",
  "| Model                                                    | requests per 5 hour       | requests per week          | requests per month          |",
  "| -------------------------------------------------------- | ------------------------- | -------------------------- | --------------------------- |",
  "| GLM-5.3                                                  | 220                       | 540                        | 1,080                       |",
  "| GLM-5.2                                                  | 880                       | 2,150                      | 4,300                       |",
  "| Kimi K2.6                                                | 1,150                     | 2,880                      | 5,750                       |",
  "| GPT 5.6 Luna                                             | 2,050                     | 5,100                      | 10,250                      |",
  "| DeepSeek V4.1 Flash<br /><small>4x · Ends Sep 27</small> | ~~6,500~~<br />**26,000** | ~~16,250~~<br />**65,000** | ~~32,500~~<br />**130,000** |",
  "",
  "The estimates use the following token counts per request; actual usage varies.",
  "- GLM-5.3/5.2/5.1 — 700 input, 52,000 cached, 150 output tokens per request",
  "- Kimi K2.7/K2.6 — 870 input, 55,000 cached, 200 output tokens per request",
  "- GPT 5.6 Luna — 1,000 input, 50,000 cached, 220 output tokens per request",
  "- DeepSeek V4.1 Flash — 410 input, 71,300 cached, 310 output tokens per request",
  "",
  "---",
  "",
  "## Endpoints",
  "",
  "| Model               | Model ID                  | Endpoint | AI SDK Package |",
  "| ------------------- | ------------------------- | -------- | -------------- |",
  "| GLM-5.3             | `glm-5.3`                 | x        | x              |",
  "| GLM-5.2             | `glm-5.2`                 | x        | x              |",
  "| Kimi K2.6           | `kimi-k2.6`               | x        | x              |",
  "| GPT 5.6 Luna        | `gpt-5.6-luna`            | x        | x              |",
  "| DeepSeek V4.1 Flash | `deepseek-v4.1-flash`     | x        | x              |",
  "",
  "---",
].join("\n")

describe("GoCapacityPrior", () => {
  test("parses current request-capacity, pricing, and token-profile syntax by canonical endpoint model id", () => {
    const at = Date.UTC(2026, 8, 21)
    const models = GoCapacityPrior.parse(DOC, at)
    expect(models.map((model) => model.modelID)).toEqual([
      "glm-5.3",
      "glm-5.2",
      "kimi-k2.6",
      "gpt-5.6-luna",
      "deepseek-v4.1-flash",
    ])

    const glm53 = models.find((model) => model.modelID === "glm-5.3")!
    const glm52 = models.find((model) => model.modelID === "glm-5.2")!
    const kimi = models.find((model) => model.modelID === "kimi-k2.6")!
    expect(glm53.requests["5h"]).toEqual({ standard: 220 })
    expect(glm52.requests.month).toEqual({ standard: 4300 })
    expect(glm53.profile).toEqual({ input: 700, cached: 52_000, output: 150 })
    expect(glm52.profile).toEqual(glm53.profile)
    expect(kimi.profile).toEqual({ input: 870, cached: 55_000, output: 200 })
    expect(glm53.pricing).toEqual([
      { kind: "flat", prices: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
    ])
  })

  test("prices threshold and time regimes against exact token vectors", () => {
    const at = Date.UTC(2026, 8, 21)
    const models = GoCapacityPrior.parse(DOC, at)
    const luna = models.find((model) => model.modelID === "gpt-5.6-luna")!
    const deepseek = models.find((model) => model.modelID === "deepseek-v4.1-flash")!

    const low = GoCapacityPrior.priceTokens(luna, {
      input: 1_000,
      cacheRead: 50_000,
      cacheWrite: 0,
      output: 220,
      reasoning: 0,
    })!
    const high = GoCapacityPrior.priceTokens(luna, {
      input: 10_000,
      cacheRead: 300_000,
      cacheWrite: 0,
      output: 220,
      reasoning: 0,
    })!
    expect(high).toBeGreaterThan(low)
    expect(GoCapacityPrior.priceTypical(luna)).toBeCloseTo(low, 12)

    const offPeak = (410 * 0.15 + 71_300 * 0.003 + 310 * 0.6) / 1_000_000
    const peak = (410 * 0.3 + 71_300 * 0.006 + 310 * 1.2) / 1_000_000
    const expected = offPeak * (133 / 168) + peak * (35 / 168)
    expect(GoCapacityPrior.priceTypical(deepseek)).toBeCloseTo(expected, 12)
  })

  test("uses the published promotion only through its advertised expiry", () => {
    const at = Date.UTC(2026, 8, 21)
    const prior = GoCapacityPrior.parse(DOC, at).find((model) => model.modelID === "deepseek-v4.1-flash")!
    expect(prior.requests["5h"]).toEqual({ standard: 6500, promoted: 26_000 })
    expect(prior.promotionEndsAt).toBe(Date.UTC(2026, 8, 27, 23, 59, 59, 999))
    expect(GoCapacityPrior.requestsAt(prior, "5h", Date.UTC(2026, 8, 27))).toBe(26_000)
    expect(GoCapacityPrior.requestsAt(prior, "5h", Date.UTC(2026, 8, 28))).toBe(6_500)
  })

  test("fails closed when the expected semantic sections are absent", () => {
    expect(GoCapacityPrior.parse("# unrelated")).toEqual([])
  })

  test("single-flights refreshes and serves stale last-good on later failure", async () => {
    let now = 100
    let calls = 0
    let fail = false
    const cache = GoCapacityPrior.createCache({
      now: () => now,
      ttlMs: 50,
      fetch: async () => {
        calls++
        if (fail) return new Response("nope", { status: 503 })
        return new Response(DOC, { status: 200 })
      },
    })

    const [a, b] = await Effect.runPromise(Effect.all([cache.get(), cache.get()], { concurrency: "unbounded" }))
    expect(calls).toBe(1)
    expect(a.status).toBe("ok")
    expect(b.models.length).toBe(5)

    now = 200
    fail = true
    const stale = await Effect.runPromise(cache.get())
    expect(calls).toBe(2)
    expect(stale.status).toBe("stale")
    expect(stale.models.length).toBe(5)
  })
})
