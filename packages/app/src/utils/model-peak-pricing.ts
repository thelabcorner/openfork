// DeepSeek V4 Flash / Pro on OpenCode Zen are priced by time-of-day rate
// period. Peak hours are 01:00-04:00 and 06:00-10:00 UTC; all other hours are
// off-peak. See https://opencode.ai/docs/zen/#pricing

export type DeepSeekRatePeriod = "peak" | "off-peak"

export const isDeepSeekPeakPricedModel = (model: { id: string; provider: { id: string } }) =>
  model.provider.id.startsWith("opencode") &&
  (model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")

const PEAK_WINDOWS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

export function deepSeekRatePeriod(date: Date): DeepSeekRatePeriod {
  const hour = date.getUTCHours()
  return PEAK_WINDOWS.some((window) => hour >= window.start && hour < window.end) ? "peak" : "off-peak"
}

export type DeepSeekRate = { input: number; output: number; cacheRead: number }

// Published rates ($/1M tokens), not derivable from the live `Model.cost`
// field (which only ever reflects a single snapshot rate, not both periods)
// — see https://opencode.ai/docs/zen/#pricing. Same drift risk as any other
// hardcoded price table; revisit if OpenCode Zen adds more time-priced models
// or changes these figures.
export const DEEPSEEK_PEAK_RATES: Record<string, { "off-peak": DeepSeekRate; peak: DeepSeekRate }> = {
  "deepseek-v4-pro": {
    "off-peak": { input: 0.66, output: 1.98, cacheRead: 0.022 },
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
  "deepseek-v4-flash": {
    "off-peak": { input: 0.22, output: 0.66, cacheRead: 0.007 },
    peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
  },
}
