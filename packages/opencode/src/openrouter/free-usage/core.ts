import type { AnalyticsRow, FreeDailyLimit, FreeModelUsage, ModelCatalogEntry, ModelPricing } from "./types";

const DAY_MS = 86_400_000;

export function asNonNegativeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function utcDayStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function nextUtcMidnight(date = new Date()): Date {
  return new Date(utcDayStart(date).getTime() + DAY_MS);
}

export function dailyLimitForPurchasedCredits(totalCredits: number): FreeDailyLimit {
  return Number.isFinite(totalCredits) && totalCredits >= 10 ? 1000 : 50;
}

export function isFreeModel(model: unknown, variant?: unknown): model is string {
  return typeof model === "string" && (model === "openrouter/free" || model.endsWith(":free") || variant === "free");
}

export function paidSiblingCandidate(model: string, variant?: unknown): string | null {
  if (model === "openrouter/free") return null;
  if (model.endsWith(":free")) return model.slice(0, -":free".length);
  return variant === "free" ? model : null;
}

export function remainingPercent(remaining: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

export function quotaStatus(percent: number): "healthy" | "draining" | "low" | "critical" | "terminal" | "depleted" {
  if (percent <= 0) return "depleted";
  if (percent < 2.5) return "terminal";
  if (percent < 10) return "critical";
  if (percent < 25) return "low";
  if (percent < 50) return "draining";
  return "healthy";
}

export function normalizeAnalyticsRow(row: AnalyticsRow): FreeModelUsage | null {
  const model = typeof row.model === "string" ? row.model : "";
  if (!isFreeModel(model, row.variant)) return null;
  const prompt = asNonNegativeNumber(row.tokens_prompt);
  const completion = asNonNegativeNumber(row.tokens_completion);
  const reasoning = Math.min(asNonNegativeNumber(row.reasoning_tokens), completion);
  const reportedTotal = asNonNegativeNumber(row.tokens_total);
  return {
    model,
    paidSibling: paidSiblingCandidate(model, row.variant),
    requests: Math.floor(asNonNegativeNumber(row.request_count)),
    tokens: {
      prompt,
      completion,
      reasoning,
      total: reportedTotal || prompt + completion,
    },
    value: { equivalentPaidValueUsd: null, pricingFound: false },
  };
}

function price(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function valueAggregate(model: FreeModelUsage, pricing: ModelPricing): number | null {
  const promptPrice = price(pricing.prompt);
  const completionPrice = price(pricing.completion);
  const requestPrice = price(pricing.request) ?? 0;
  const reasoningPrice = price(pricing.internal_reasoning);
  if (promptPrice === null && completionPrice === null && reasoningPrice === null && requestPrice === 0) return null;

  const separatelyPricedReasoning = reasoningPrice !== null && reasoningPrice > 0;
  const ordinaryCompletion = separatelyPricedReasoning
    ? Math.max(0, model.tokens.completion - model.tokens.reasoning)
    : model.tokens.completion;

  return (
    model.tokens.prompt * (promptPrice ?? 0) +
    ordinaryCompletion * (completionPrice ?? 0) +
    (separatelyPricedReasoning ? model.tokens.reasoning * reasoningPrice : 0) +
    model.requests * requestPrice
  );
}

export function catalogPricingMap(models: ModelCatalogEntry[]): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const model of models) {
    if (typeof model.id === "string" && model.pricing) map.set(model.id, model.pricing);
  }
  return map;
}

export interface BurnSample { atMs: number; used: number; dayStartMs: number }

export function computeBurnRate(samples: BurnSample[], used: number, nowMs: number, dayStartMs: number): {
  requestsPerHour: number;
  requestsPerMinute: number;
  source: "snapshot-delta" | "day-average" | "insufficient-data";
} {
  const currentDay = samples.filter((sample) => sample.dayStartMs === dayStartMs && sample.atMs < nowMs && sample.used <= used);
  const candidate = currentDay.find((sample) => nowMs - sample.atMs >= 10_000) ?? currentDay.at(-1);
  if (candidate && nowMs > candidate.atMs && used >= candidate.used) {
    const delta = used - candidate.used;
    const hours = (nowMs - candidate.atMs) / 3_600_000;
    if (hours > 0) {
      const requestsPerHour = delta / hours;
      return { requestsPerHour, requestsPerMinute: requestsPerHour / 60, source: "snapshot-delta" };
    }
  }

  const hoursSinceStart = (nowMs - dayStartMs) / 3_600_000;
  if (hoursSinceStart >= 1 / 60 && used > 0) {
    const requestsPerHour = used / hoursSinceStart;
    return { requestsPerHour, requestsPerMinute: requestsPerHour / 60, source: "day-average" };
  }
  return { requestsPerHour: 0, requestsPerMinute: 0, source: "insufficient-data" };
}

export function computeProjection(args: { remaining: number; secondsUntilReset: number; requestsPerHour: number; rateSource: "snapshot-delta" | "day-average" | "insufficient-data"; nowMs: number }) {
  const { remaining, secondsUntilReset, requestsPerHour, rateSource, nowMs } = args;
  const hoursUntilReset = Math.max(0, secondsUntilReset / 3600);
  const sustainableRequestsPerHour = hoursUntilReset > 0 ? remaining / hoursUntilReset : 0;
  const projectedRemainingAtReset = Math.max(0, Math.floor(remaining - requestsPerHour * hoursUntilReset));
  const secondsToEmpty = requestsPerHour > 0 ? (remaining / requestsPerHour) * 3600 : null;
  const willExhaustBeforeReset = secondsToEmpty !== null && secondsToEmpty < secondsUntilReset;
  return {
    requestsPerHour,
    rateSource,
    sustainableRequestsPerHour,
    projectedRemainingAtReset,
    willExhaustBeforeReset,
    estimatedExhaustionAt: willExhaustBeforeReset && secondsToEmpty !== null
      ? new Date(nowMs + secondsToEmpty * 1000).toISOString()
      : null,
  };
}

