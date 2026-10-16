/**
 * Counterfactual OpenAI Standard API valuation of OXP activity. These are
 * published USD / 1M token prices, NOT ChatGPT charges or model identification.
 * Source: https://developers.openai.com/api/docs/pricing (2026-10-11).
 *
 * OXP invocation request/result payloads are model-visible INPUT. The paired
 * OpenFork calibration estimates surrounding TOTAL tokens (including output),
 * but does not identify ChatGPT input/output/cache splits. Those dimensions
 * must remain explicit, adjustable scenario assumptions.
 */
export const OXP_API_MODELS = [
  { id: "gpt-6-luna", label: "GPT-6 Luna", input: 0.1, cachedInput: 0.01, output: 0.5 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", input: 2, cachedInput: 0.2, output: 10 },
  { id: "gpt-6-astra", label: "GPT-6 Astra", input: 10, cachedInput: 1, output: 50 },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", input: 2, cachedInput: 0.1, output: 10 },
] as const

export type OxpApiModel = (typeof OXP_API_MODELS)[number]
export type OxpContextTier = "short" | "long"

export interface OxpApiScenario {
  readonly surroundingOutputPercent: number
  readonly cachedInputPercent: number
  /** Tool request/result payload cache ratio is independent and unavailable upstream.
   * Defaults to 0%, never automatically inherits a local whole-prompt cache ratio. */
  readonly oxpCachedInputPercent?: number
  /** Per-request >272K *input* tokens, not aggregate OXP usage over an interval. */
  readonly contextTier: OxpContextTier
}

export interface OxpApiValuation {
  readonly model: OxpApiModel
  readonly inputRate: number
  readonly oxpInputRate: number
  readonly outputRate: number
  readonly oxp: number
  readonly surrounding: number
  readonly total: number
}

function nonnegative(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function fraction(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value / 100)) : 0
}

/** Pure, O(1) pricing per model: never invent cache hits or a provider token split. */
export function valueOxpApiUsage(
  model: OxpApiModel,
  tokens: { readonly oxp: number; readonly surrounding: number },
  scenario: OxpApiScenario,
): OxpApiValuation {
  const cached = fraction(scenario.cachedInputPercent)
  const output = fraction(scenario.surroundingOutputPercent)
  const inputMultiplier = scenario.contextTier === "long" ? 2 : 1
  const outputMultiplier = scenario.contextTier === "long" ? 1.5 : 1
  const oxpCache = fraction(scenario.oxpCachedInputPercent ?? 0)
  const inputRate = (model.input * (1 - cached) + model.cachedInput * cached) * inputMultiplier
  const oxpInputRate = (model.input * (1 - oxpCache) + model.cachedInput * oxpCache) * inputMultiplier
  const outputRate = model.output * outputMultiplier
  const oxp = (nonnegative(tokens.oxp) * oxpInputRate) / 1_000_000
  const surrounding =
    (nonnegative(tokens.surrounding) * ((1 - output) * inputRate + output * outputRate)) / 1_000_000
  return { model, inputRate, oxpInputRate, outputRate, oxp, surrounding, total: oxp + surrounding }
}

export function estimateOxpApiCosts(
  tokens: { readonly oxp: number; readonly surrounding: number },
  scenario: OxpApiScenario,
): OxpApiValuation[] {
  return OXP_API_MODELS.map((model) => valueOxpApiUsage(model, tokens, scenario))
}

/** Small US-dollar values should not disappear as $0.00 when comparing Luna. */
export function formatOxpDollar(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—"
  if (value === 0) return "$0.00"
  if (value < 0.0001) return "<$0.0001"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.01 ? 4 : value < 1 ? 3 : 2,
  }).format(value)
}
