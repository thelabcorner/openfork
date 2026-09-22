export * as GoCapacityPrior from "./go-prior"

import { Effect } from "effect"

export const SOURCE_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx"
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const FETCH_TIMEOUT_MS = 5_000

export type Window = "5h" | "week" | "month"

export interface TypicalProfile {
  readonly input: number
  readonly cached: number
  readonly output: number
}

export interface PublishedRequestLimit {
  readonly standard: number
  readonly promoted?: number
}

export interface PriceCard {
  /** USD per 1M tokens. */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type PricingRegime =
  | { readonly kind: "flat"; readonly prices: PriceCard }
  | {
      readonly kind: "context"
      readonly thresholdTokens: number
      readonly operator: "<=" | ">"
      readonly prices: PriceCard
    }
  | {
      readonly kind: "time"
      readonly label: "peak" | "off-peak"
      readonly fraction: number
      readonly prices: PriceCard
    }

export interface ModelPrior {
  readonly modelID: string
  readonly name: string
  readonly requests: Readonly<Record<Window, PublishedRequestLimit>>
  readonly profile?: TypicalProfile
  readonly pricing?: readonly PricingRegime[]
  readonly promotionEndsAt?: number
}

export interface Snapshot {
  readonly models: readonly ModelPrior[]
  readonly fetchedAt: number
  readonly status: "ok" | "stale" | "error"
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function cleanMarkup(value: string) {
  return value
    .replace(/<small>.*?<\/small>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanModelName(value: string) {
  return cleanMarkup(value).replace(/\s+4x\s*·?\s*Ends\s+.+$/i, "").trim()
}

function normalize(value: string) {
  return cleanModelName(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

function tableRows(section: string) {
  const rows: string[][] = []
  for (const raw of section.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith("|")) continue
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length === 0) continue
    if (cells.every((cell) => /^[-: ]+$/.test(cell))) continue
    rows.push(cells)
  }
  return rows
}

function sectionBetween(markdown: string, startPattern: RegExp, endPattern?: RegExp) {
  const start = markdown.search(startPattern)
  if (start < 0) return ""
  const rest = markdown.slice(start)
  if (!endPattern) return rest
  const match = rest.slice(1).search(endPattern)
  return match < 0 ? rest : rest.slice(0, match + 1)
}

function endpointModelIDs(markdown: string) {
  const section = sectionBetween(markdown, /^## Endpoints\s*$/m, /^---\s*$|^## /m)
  const result = new Map<string, { modelID: string; name: string }>()
  for (const cells of tableRows(section)) {
    if (cells.length < 2 || /^model$/i.test(cleanMarkup(cells[0] ?? ""))) continue
    const name = cleanModelName(cells[0] ?? "")
    const id = cleanMarkup(cells[1] ?? "").replace(/`/g, "").trim()
    if (!name || !id || /model id/i.test(id)) continue
    result.set(normalize(name), { modelID: id, name })
  }
  return result
}

function parseMoney(value: string) {
  const match = value.match(/\$([\d.]+)/)
  if (!match) return 0
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function pricingByModel(
  markdown: string,
  endpoints: ReadonlyMap<string, { modelID: string; name: string }>,
) {
  const section = sectionBetween(markdown, /^## Usage limits\s*$/m, /^### Estimated requests\s*$/m)
  const grouped = new Map<string, PricingRegime[]>()
  const peakFraction = 35 / 168
  const offPeakFraction = 133 / 168

  for (const cells of tableRows(section)) {
    if (cells.length < 5 || /^model$/i.test(cleanMarkup(cells[0] ?? ""))) continue
    const rawName = cells[0] ?? ""
    const baseName = cleanModelName(rawName.replace(/\s*\([^)]*\)/g, ""))
    const endpoint = findEndpoint(endpoints, baseName)
    if (!endpoint) continue

    const prices: PriceCard = {
      input: parseMoney(cells[1] ?? ""),
      output: parseMoney(cells[2] ?? ""),
      cacheRead: parseMoney(cells[3] ?? ""),
      cacheWrite: parseMoney(cells[4] ?? ""),
    }
    if (!(prices.input > 0) || !(prices.output > 0)) continue

    const qualifier = rawName.match(/\(([^)]+)\)/)?.[1]?.toLowerCase()
    let regime: PricingRegime
    if (qualifier?.includes("off-peak")) {
      regime = { kind: "time", label: "off-peak", fraction: offPeakFraction, prices }
    } else if (qualifier?.includes("peak")) {
      regime = { kind: "time", label: "peak", fraction: peakFraction, prices }
    } else {
      const threshold = qualifier
        ?.replace(/≤/g, "<=")
        .replace(/≥/g, ">=")
        .match(/([<>]=?)\s*([\d.]+)\s*k/i)
      if (threshold) {
        const tokens = Number(threshold[2]) * 1000
        const operator: "<=" | ">" = threshold[1] === "<=" || threshold[1] === "<" ? "<=" : ">"
        regime = { kind: "context", thresholdTokens: tokens, operator, prices }
      } else {
        regime = { kind: "flat", prices }
      }
    }

    const list = grouped.get(endpoint.modelID) ?? []
    list.push(regime)
    grouped.set(endpoint.modelID, list)
  }

  return grouped
}

function numericValues(value: string) {
  return [...value.matchAll(/(?<![A-Za-z])([\d][\d,]*)/g)]
    .map((match) => Number(match[1]!.replace(/,/g, "")))
    .filter((item) => Number.isFinite(item) && item > 0)
}

function requestLimit(value: string): PublishedRequestLimit | undefined {
  const values = numericValues(value)
  if (values.length === 0) return undefined
  if (values.length === 1) return { standard: values[0]! }
  return { standard: values[0]!, promoted: values[values.length - 1]! }
}

const MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((name, index) => [
    name,
    index,
  ]),
)

function promotionEnd(modelCell: string, referenceTime: number) {
  const text = modelCell
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*|~~/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const match = text.match(/Ends\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?/i)
  if (!match) return undefined
  const month = MONTHS.get(match[1]!.slice(0, 3).toLowerCase())
  const day = Number(match[2])
  if (month === undefined || !Number.isFinite(day)) return undefined

  const reference = new Date(referenceTime)
  let year = match[3] ? Number(match[3]) : reference.getUTCFullYear()
  let end = Date.UTC(year, month, day, 23, 59, 59, 999)
  if (!match[3] && end < referenceTime - 183 * 24 * 60 * 60 * 1000) {
    year += 1
    end = Date.UTC(year, month, day, 23, 59, 59, 999)
  }
  return end
}

function expandNames(raw: string) {
  const parts = raw.split("/").map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return parts

  const first = parts[0]!
  const numericTail = first.match(/^(.*?)(\d[\d.]*)$/)
  const lastSpace = first.lastIndexOf(" ")
  return [
    first,
    ...parts.slice(1).map((part) => {
      if (/^\d[\d.]*$/.test(part) && numericTail) return numericTail[1] + part
      if (lastSpace >= 0 && !part.includes(" ")) return first.slice(0, lastSpace + 1) + part
      return part
    }),
  ]
}

function profiles(markdown: string) {
  const start = markdown.search(/The estimates (?:use|are based on).*token counts per request/i)
  if (start < 0) return new Map<string, TypicalProfile>()
  const section = markdown.slice(start)
  const result = new Map<string, TypicalProfile>()
  const line =
    /^-\s*(.+?)\s*[—-]\s*([\d,]+)\s*input,\s*([\d,]+)\s*cached,\s*([\d,]+)\s*output tokens per request/gim
  for (const match of section.matchAll(line)) {
    const profile: TypicalProfile = {
      input: Number(match[2]!.replace(/,/g, "")),
      cached: Number(match[3]!.replace(/,/g, "")),
      output: Number(match[4]!.replace(/,/g, "")),
    }
    for (const name of expandNames(match[1]!)) result.set(normalize(name), profile)
  }
  return result
}

function findEndpoint(
  endpoints: ReadonlyMap<string, { modelID: string; name: string }>,
  name: string,
) {
  const key = normalize(name)
  const exact = endpoints.get(key)
  if (exact) return exact
  const candidates = [...endpoints.entries()].filter(
    ([candidate]) => candidate.includes(key) || key.includes(candidate),
  )
  return candidates.length === 1 ? candidates[0]![1] : undefined
}

function findProfile(source: ReadonlyMap<string, TypicalProfile>, name: string) {
  const key = normalize(name)
  const exact = source.get(key)
  if (exact) return exact
  const candidates = [...source.entries()].filter(
    ([candidate]) => candidate.includes(key) || key.includes(candidate),
  )
  return candidates.length === 1 ? candidates[0]![1] : undefined
}

export function parse(markdown: string, referenceTime = Date.now()): ModelPrior[] {
  const endpoints = endpointModelIDs(markdown)
  const typical = profiles(markdown)
  if (endpoints.size === 0) return []
  const pricing = pricingByModel(markdown, endpoints)

  const section = sectionBetween(markdown, /^### Estimated requests\s*$/m, /^The estimates /m)
  const result: ModelPrior[] = []
  const seen = new Set<string>()

  for (const cells of tableRows(section)) {
    if (cells.length < 4 || /requests per 5 hour/i.test(cleanMarkup(cells[1] ?? ""))) continue
    const publishedName = cleanModelName(cells[0] ?? "")
    const endpoint = findEndpoint(endpoints, publishedName)
    if (!endpoint || seen.has(endpoint.modelID)) continue

    const fiveHour = requestLimit(cells[1] ?? "")
    const week = requestLimit(cells[2] ?? "")
    const month = requestLimit(cells[3] ?? "")
    if (!fiveHour || !week || !month) continue

    seen.add(endpoint.modelID)
    const profile = findProfile(typical, publishedName)
    const promotionEndsAt = promotionEnd(cells[0] ?? "", referenceTime)
    result.push({
      modelID: endpoint.modelID,
      name: endpoint.name,
      requests: { "5h": fiveHour, week, month },
      ...(profile ? { profile } : {}),
      ...(pricing.get(endpoint.modelID)?.length ? { pricing: pricing.get(endpoint.modelID)! } : {}),
      ...(promotionEndsAt === undefined ? {} : { promotionEndsAt }),
    })
  }

  return result
}

export function requestsAt(prior: ModelPrior, window: Window, at = Date.now()) {
  const value = prior.requests[window]
  if (value.promoted === undefined) return value.standard
  if (prior.promotionEndsAt !== undefined && at > prior.promotionEndsAt) return value.standard
  return value.promoted
}

export function priceTokens(
  prior: ModelPrior,
  tokens: {
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  },
) {
  const regimes = prior.pricing
  if (!regimes || regimes.length === 0) return undefined

  const costWith = (prices: PriceCard) =>
    (tokens.input * prices.input +
      tokens.cacheRead * prices.cacheRead +
      tokens.cacheWrite * prices.cacheWrite +
      (tokens.output + tokens.reasoning) * prices.output) /
    1_000_000

  const time = regimes.filter((regime): regime is Extract<PricingRegime, { kind: "time" }> => regime.kind === "time")
  if (time.length > 0) {
    const totalFraction = time.reduce((sum, regime) => sum + regime.fraction, 0)
    if (!(totalFraction > 0)) return undefined
    return time.reduce((sum, regime) => sum + costWith(regime.prices) * regime.fraction, 0) / totalFraction
  }

  const context = regimes.filter(
    (regime): regime is Extract<PricingRegime, { kind: "context" }> => regime.kind === "context",
  )
  if (context.length > 0) {
    const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
    const matched =
      context.find((regime) => regime.operator === "<=" && promptTokens <= regime.thresholdTokens) ??
      context.find((regime) => regime.operator === ">" && promptTokens > regime.thresholdTokens)
    if (matched) return costWith(matched.prices)
  }

  const flat = regimes.find((regime): regime is Extract<PricingRegime, { kind: "flat" }> => regime.kind === "flat")
  return flat ? costWith(flat.prices) : undefined
}

export function priceTypical(prior: ModelPrior) {
  if (!prior.profile) return undefined
  return priceTokens(prior, {
    input: prior.profile.input,
    cacheRead: prior.profile.cached,
    cacheWrite: 0,
    output: prior.profile.output,
    reasoning: 0,
  })
}

export function createCache(
  options: {
    readonly fetch?: FetchFn
    readonly now?: () => number
    readonly ttlMs?: number
    readonly timeoutMs?: number
  } = {},
) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  let lastGood: Snapshot | undefined
  let inFlight: Promise<Snapshot> | undefined
  let inFlightAt = 0

  const fetchFresh = async () => {
    const at = now()
    try {
      const response = await fetchImpl(SOURCE_URL, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error("status " + response.status)
      const models = parse(await response.text(), at)
      if (models.length === 0) throw new Error("Go capacity prior parse returned no models")
      lastGood = { models, fetchedAt: at, status: "ok" }
      return lastGood
    } catch {
      if (lastGood) return { ...lastGood, status: "stale" as const }
      return { models: [], fetchedAt: 0, status: "error" as const }
    }
  }

  return {
    get: Effect.fn("GoCapacityPrior.get")(function* () {
      const at = now()
      if (lastGood && at - lastGood.fetchedAt < ttlMs) return lastGood
      if (!inFlight || at - inFlightAt >= ttlMs) {
        inFlightAt = at
        inFlight = fetchFresh().finally(() => {
          inFlight = undefined
        })
      }
      return yield* Effect.promise(() => inFlight!)
    }),
  }
}

export const cache = createCache()
