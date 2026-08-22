import type { ProviderResult, UsageWindow } from "./schema"

/**
 * Pure normalization helpers for quota payloads, ported from OpenChamber
 * (MIT): packages/web/server/lib/quota/utils/{formatters,transformers}.js.
 *
 * Unlike the source, reset strings are NOT pre-formatted server-side: the
 * app owns localization, so `resetAt`/`resetAfterSeconds` are the canonical
 * machine fields and clients derive human text from them.
 */

export const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// Providers mix epoch seconds and milliseconds (and occasionally ISO
// strings); 1e12 separates the two magnitudes.
export const toTimestamp = (value: unknown): number | null => {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const numeric = toNumber(value)
  if (numeric === null || numeric <= 0) return null
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
}

export const formatMoney = (value: number): string | null => (Number.isFinite(value) ? value.toFixed(2) : null)

export const calculateResetAfterSeconds = (resetAt: number | null): number | null => {
  if (resetAt === null || !Number.isFinite(resetAt)) return null
  return Math.max(0, Math.round((resetAt - Date.now()) / 1000))
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

const finiteOrNull = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isFinite(value) ? value : null

export const toUsageWindow = (input: {
  usedPercent: number | null
  windowSeconds?: number | null
  resetAt?: number | null
  valueLabel?: string | null
}): UsageWindow => {
  const finite = finiteOrNull(input.usedPercent)
  const usedPercent = finite === null ? null : clampPercent(finite)
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : clampPercent(100 - usedPercent),
    windowSeconds: finiteOrNull(input.windowSeconds ?? null),
    resetAt: finiteOrNull(input.resetAt ?? null),
    resetAfterSeconds: calculateResetAfterSeconds(finiteOrNull(input.resetAt ?? null)),
    valueLabel: input.valueLabel ?? null,
  }
}

export const buildResult = (input: {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  error?: string
  usage?: ProviderResult["usage"]
  fetchedAt?: number
}): ProviderResult => ({
  providerId: input.providerId,
  providerName: input.providerName,
  ok: input.ok,
  configured: input.configured,
  ...(input.error !== undefined ? { error: input.error } : {}),
  usage: input.usage ?? null,
  fetchedAt: input.fetchedAt ?? Date.now(),
})

/**
 * Kimi reports weekly `used` but rate-limit `remaining`; neither is
 * guaranteed. `used` wins when both exist, and a missing/zero total means
 * no percentage rather than NaN.
 */
export const computeUsedPercent = (
  total: number | null,
  used: number | null,
  remaining: number | null,
): number | null => {
  if (total === null || total <= 0) return null
  if (used !== null) return clampPercent((used / total) * 100)
  if (remaining !== null) return clampPercent(100 - (remaining / total) * 100)
  return null
}

const TIME_UNIT_SECONDS: Record<number, number> = { 1: 60, 3: 3600, 6: 86400 }

export const durationToSeconds = (duration: unknown, unit: unknown): number | null => {
  const value = toNumber(duration)
  const multiplier = toNumber(unit)
  if (value === null || multiplier === null) return null
  const seconds = TIME_UNIT_SECONDS[multiplier]
  return seconds === undefined ? null : value * seconds
}

export const durationToLabel = (duration: unknown, unit: unknown): string => {
  const value = toNumber(duration)
  const unitNumber = toNumber(unit)
  if (value === null || unitNumber === null) return "limit"
  const suffix = unitNumber === 1 ? "m" : unitNumber === 3 ? "h" : unitNumber === 6 ? "d" : null
  if (suffix === null) return "limit"
  const normalized = Number.isInteger(value) ? value : Number(value.toFixed(1))
  return `${normalized}${suffix}`
}
