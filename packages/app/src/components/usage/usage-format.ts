const formatterCache = new Map<string, Intl.NumberFormat>()

function formatter(key: string, locale: string | undefined, options: Intl.NumberFormatOptions) {
  let hit = formatterCache.get(key)
  if (!hit) {
    hit = new Intl.NumberFormat(locale, options)
    formatterCache.set(key, hit)
  }
  return hit
}

export const formatUSD = (value: number, locale?: string) =>
  formatter(`usd:${locale ?? ""}`, locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)

export const formatUSDCompact = (value: number, locale?: string) =>
  formatter(`usdc:${locale ?? ""}`, locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value)

export const formatTokens = (value: number, locale?: string) =>
  formatter(`tokens:${locale ?? ""}`, locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)

export const formatTokensExact = (value: number, locale?: string) =>
  formatter(`tokense:${locale ?? ""}`, locale, { maximumFractionDigits: 0 }).format(value)

export const formatRate = (value: number, locale?: string) =>
  formatter(`rate:${locale ?? ""}`, locale, { maximumFractionDigits: 1 }).format(value)

export const formatTokensPerSecond = (value: number, locale?: string) => `${formatRate(value, locale)} tok/s`

export const formatPercent = (value: number, locale?: string) =>
  formatter(`pct:${locale ?? ""}`, locale, { style: "percent", maximumFractionDigits: 1 }).format(value)

export const formatDuration = (ms: number, locale?: string) => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export const formatNumber = (value: number, locale?: string) =>
  formatter(`num:${locale ?? ""}`, locale, { maximumFractionDigits: 0 }).format(value)

/** 12-hour clock label for hour-of-day buckets, e.g. 0 → "12AM", 13 → "1PM". */
export const hourLabel = (hour: number) => {
  const suffix = hour < 12 ? "AM" : "PM"
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}${suffix}`
}
