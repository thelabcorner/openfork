// Pulls the per-model "observed request patterns" (avg input/cached/output
// tokens per request) that OpenCode Go's own docs publish, straight from the
// raw doc source, so the per-model usage estimate in the model selector stays
// current as models are added/removed/repriced without us hand-maintaining a
// copy of their table. Best-effort: on fetch failure or parse miss for a
// given model, callers fall back to the flat generic profile in
// model-usage-estimate.ts.

export type UsageProfile = { input: number; cached: number; output: number }
export type UsagePricing = { input: number; output: number; cache: { read: number; write: number } }
type ProfileEntry = { names: string[]; profile: UsageProfile }
type PricingEntry = { names: string[]; pricing: UsagePricing }
type CacheEntry = { fetchedAt: number; entries: ProfileEntry[] }

const SOURCE_URL = "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx"
const CACHE_KEY = "opencode.go-usage-profile.v1"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

let memoryCache: CacheEntry | undefined
let inflight: Promise<CacheEntry | undefined> | undefined
let pricingCache: { fetchedAt: number; entries: PricingEntry[] } | undefined
let pricingInflight: Promise<PricingEntry[]> | undefined

function readCache(): CacheEntry | undefined {
  if (memoryCache) return memoryCache
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    memoryCache = JSON.parse(raw) as CacheEntry
    return memoryCache
  } catch {
    return undefined
  }
}

function writeCache(entry: CacheEntry) {
  memoryCache = entry
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // best-effort cache only
  }
}

// "GLM-5.3/5.2/5.1" -> ["GLM-5.3", "GLM-5.2", "GLM-5.1"] (numeric-only
// suffixes inherit the leading model's prefix).
// "Kimi K2.7/K2.6" -> ["Kimi K2.7", "K2.6"] (non-numeric suffixes are kept
// as-is; they're specific enough on their own for fuzzy matching below).
function expandNames(raw: string): string[] {
  const parts = raw.split("/").map((part) => part.trim())
  if (parts.length === 1) return parts
  const first = parts[0]
  const match = first.match(/^(.*?)([\d.]+)$/)
  const prefix = match?.[1]
  return [first, ...parts.slice(1).map((part) => (prefix && /^[\d.]+$/.test(part) ? `${prefix}${part}` : part))]
}

function parseProfileTable(markdown: string): ProfileEntry[] {
  const marker = "The estimates are based on observed request patterns:"
  const start = markdown.indexOf(marker)
  if (start === -1) return []
  const rest = markdown.slice(start + marker.length)
  const end = rest.indexOf("The estimates are also based on")
  const section = end === -1 ? rest : rest.slice(0, end)
  const lineRe = /^-\s*(.+?)\s*[—-]\s*([\d,]+)\s*input,\s*([\d,]+)\s*cached,\s*([\d,]+)\s*output tokens per request/gm
  const entries: ProfileEntry[] = []
  for (const match of section.matchAll(lineRe)) {
    const [, rawNames, input, cached, output] = match
    entries.push({
      names: expandNames(rawNames),
      profile: {
        input: Number(input.replace(/,/g, "")),
        cached: Number(cached.replace(/,/g, "")),
        output: Number(output.replace(/,/g, "")),
      },
    })
  }
  return entries
}

function parseMoney(value: string) {
  const match = value.match(/\$([\d.]+)/)
  return match ? Number(match[1]) : 0
}

function parsePricingTable(markdown: string): PricingEntry[] {
  const start = markdown.indexOf("prices per 1M tokens")
  if (start === -1) return []
  const entries: PricingEntry[] = []
  for (const line of markdown.slice(start).split("\n")) {
    if (!line.trimStart().startsWith("|")) continue
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 5 || cells[0] === "Model" || /^[-: ]+$/.test(cells[0])) continue
    entries.push({
      names: expandNames(cells[0].replace(/\s*\([^)]*\)/g, "")),
      pricing: {
        input: parseMoney(cells[1]),
        output: parseMoney(cells[2]),
        cache: { read: parseMoney(cells[3]), write: parseMoney(cells[4]) },
      },
    })
  }
  return entries
}

export async function getUsageProfileTable(): Promise<ProfileEntry[]> {
  const cached = readCache()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries
  if (!inflight) {
    inflight = fetch(SOURCE_URL)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`status ${res.status}`))))
      .then((markdown) => {
        const entries = parseProfileTable(markdown)
        if (entries.length === 0) return cached
        const entry: CacheEntry = { fetchedAt: Date.now(), entries }
        writeCache(entry)
        return entry
      })
      .catch(() => cached)
      .finally(() => {
        inflight = undefined
      })
  }
  const result = await inflight
  return result?.entries ?? cached?.entries ?? []
}

export async function getUsagePricingTable(): Promise<PricingEntry[]> {
  if (pricingCache && Date.now() - pricingCache.fetchedAt < CACHE_TTL_MS) return pricingCache.entries
  if (!pricingInflight) {
    pricingInflight = fetch(SOURCE_URL)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`status ${response.status}`))))
      .then((markdown) => {
        const entries = parsePricingTable(markdown)
        if (entries.length > 0) pricingCache = { fetchedAt: Date.now(), entries }
        return entries
      })
      .catch(() => pricingCache?.entries ?? [])
      .finally(() => {
        pricingInflight = undefined
      })
  }
  return pricingInflight
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

export function matchUsageProfile(
  entries: ProfileEntry[],
  model: { name: string; family?: string; id: string },
): UsageProfile | undefined {
  const candidates = [model.family, model.name, model.id].filter((x): x is string => !!x).map(normalize)
  for (const entry of entries) {
    for (const rawName of entry.names) {
      const key = normalize(rawName)
      if (!key) continue
      if (candidates.some((c) => c === key || c.includes(key) || key.includes(c))) return entry.profile
    }
  }
  return undefined
}

export function matchUsagePricing(
  entries: PricingEntry[],
  model: { name: string; family?: string; id: string },
): UsagePricing | undefined {
  const candidates = [model.family, model.name, model.id].filter((x): x is string => !!x).map(normalize)
  for (const entry of entries) {
    for (const rawName of entry.names) {
      const key = normalize(rawName)
      if (key && candidates.some((candidate) => candidate === key || candidate.includes(key) || key.includes(candidate))) {
        return entry.pricing
      }
    }
  }
  return undefined
}
