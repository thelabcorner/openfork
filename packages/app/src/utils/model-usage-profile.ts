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
export type PricingEntry = {
  names: string[]
  pricing: UsagePricing
  /** §8: parsed context threshold, if the row is a tiered model (e.g. Qwen ≤256K vs >256K). */
  threshold?: { operator: "<=" | ">"; tokens: number }
  /** §9: time regime for DeepSeek Off-Peak vs Peak rows. */
  timeRegime?: "peak" | "off-peak"
}
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
    const rawName = cells[0]
    // §8-9: extract regime metadata before stripping the parenthetical.
    // Order matters: check time regime first (DeepSeek), then threshold.
    let timeRegime: PricingEntry["timeRegime"] | undefined
    let threshold: PricingEntry["threshold"] | undefined
    const paren = rawName.match(/\(([^)]+)\)/)
    if (paren) {
      const inside = paren[1].toLowerCase()
      if (inside.includes("off-peak")) timeRegime = "off-peak"
      else if (inside.includes("peak") && !inside.includes("off-peak")) timeRegime = "peak"
      else {
        // Threshold variants: "≤ 200K tokens", "> 200K tokens", "≤ 256K tokens" etc.
        // The char may be ≤ (U+2264) or <=. Normalize.
        const t = inside.replace(/\u2264/g, "<=").replace(/\u2265/g, ">=")
        const m = t.match(/([<>]=?)\s*([\d.]+)\s*k/i)
        if (m) {
          const op = m[1] as "<=" | ">" | ">=" | "<"
          const num = Number(m[2]) * 1000
          if (Number.isFinite(num)) {
            // Our pricing table only uses ≤ and >.
            const normalizedOp: "<=" | ">" = op === "<=" || op === "<" ? "<=" : ">"
            threshold = { operator: normalizedOp, tokens: num }
          }
        }
      }
    }
    entries.push({
      names: expandNames(rawName.replace(/\s*\([^)]*\)/g, "")),
      pricing: {
        input: parseMoney(cells[1]),
        output: parseMoney(cells[2]),
        cache: { read: parseMoney(cells[3]), write: parseMoney(cells[4]) },
      },
      ...(threshold ? { threshold } : {}),
      ...(timeRegime ? { timeRegime } : {}),
    })
  }
  return entries
}

export type UsageTables = { profile: ProfileEntry[]; pricing: PricingEntry[] }

let tablesInflight: Promise<UsageTables | undefined> | undefined

// Fetches and parses the source doc once, returning both tables. Replaces the
// previous two independent fetches of the same URL (profile + pricing) so the
// model selector opens with a single network round-trip and parse pass.
export async function getUsageTables(): Promise<UsageTables> {
  const cachedProfile = readCache()
  const cachedPricing = pricingCache
  const profileFresh = cachedProfile && Date.now() - cachedProfile.fetchedAt < CACHE_TTL_MS
  const pricingFresh = cachedPricing && Date.now() - cachedPricing.fetchedAt < CACHE_TTL_MS
  if (profileFresh && pricingFresh) {
    return { profile: cachedProfile!.entries, pricing: cachedPricing!.entries }
  }
  if (!tablesInflight) {
    tablesInflight = fetch(SOURCE_URL)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`status ${res.status}`))))
      .then((markdown) => {
        const profile = parseProfileTable(markdown)
        const pricing = parsePricingTable(markdown)
        if (profile.length > 0) writeCache({ fetchedAt: Date.now(), entries: profile })
        if (pricing.length > 0) pricingCache = { fetchedAt: Date.now(), entries: pricing }
        return { profile, pricing }
      })
      .catch(() => ({ profile: cachedProfile?.entries ?? [], pricing: cachedPricing?.entries ?? [] }))
      .finally(() => {
        tablesInflight = undefined
      })
  }
  const result = await tablesInflight
  return result ?? { profile: cachedProfile?.entries ?? [], pricing: cachedPricing?.entries ?? [] }
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

/**
 * Collect ALL tier rows for a model (§8) — e.g. Qwen ≤256K vs >256K, Grok
 * ≤200K vs >200K — so the workload-corpus pricer (§5.2) can select the tier a
 * given workload actually activates. Returns undefined when the model has no
 * threshold tiers (the common case) or when entries are malformed.
 *
 * Time-regime rows (DeepSeek peak/off-peak) are intentionally excluded here:
 * they are handled by the time-regime branch in model-usage-yield.ts.
 */
export type ThresholdIndex = Array<{ entry: PricingEntry; keys: string[] }>

/**
 * Pre-filter the pricing table to threshold-only rows and normalize their names
 * ONCE (Y3, hoisted one level up).
 *
 * `collectThresholdPricing` is called once per model by the model selector's
 * `thresholdMap`, but the pricing table is invariant across that loop. Preparing
 * it here and passing the result to `collectThresholdPricingFromIndex` avoids
 * re-filtering every row and re-normalizing every name for every model
 * (O(models × rows × names) -> O(rows × names) + O(models × tierRows)).
 * Measured 2.7-3.0x faster on the controller's call site, identical output.
 */
export function prepareThresholdIndex(entries: PricingEntry[]): ThresholdIndex {
  return entries
    .filter((e) => !e.timeRegime && !!e.threshold)
    .map((entry) => ({ entry, keys: entry.names.map(normalize).filter((k): k is string => !!k) }))
}

/** Match one model against an already-prepared threshold index. See
 * `prepareThresholdIndex`; output is identical to `collectThresholdPricing`. */
export function collectThresholdPricingFromIndex(
  index: ThresholdIndex,
  model: { name: string; family?: string; id: string },
): Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: { input: number; output: number; cache: { read: number; write: number } } }> | undefined {
  const candidates = [model.family, model.name, model.id].filter((x): x is string => !!x).map(normalize)
  if (candidates.length === 0) return undefined
  if (index.length === 0) return undefined
  const matched: Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCostLike }> = []
  for (const { entry, keys } of index) {
    let hit = false
    for (const key of keys) {
      if (candidates.some((c) => c === key || c.includes(key) || key.includes(c))) {
        hit = true
        break
      }
    }
    if (hit) {
      matched.push({
        thresholdTokens: entry.threshold!.tokens,
        operator: entry.threshold!.operator,
        cost: { input: entry.pricing.input, output: entry.pricing.output, cache: { read: entry.pricing.cache.read, write: entry.pricing.cache.write } },
      })
    }
  }
  // §8 requires exactly one ≤ and one > with the same threshold token.
  if (matched.length !== 2) return undefined
  matched.sort((a, b) => a.thresholdTokens - b.thresholdTokens)
  if (matched[0].operator !== "<=" || matched[1].operator !== ">" || matched[0].thresholdTokens !== matched[1].thresholdTokens) return undefined
  return matched as Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: { input: number; output: number; cache: { read: number; write: number } } }>
}

/** Convenience wrapper for callers that match a single model once. Callers that
 * loop over many models against the same table should hoist
 * `prepareThresholdIndex` out of the loop and call
 * `collectThresholdPricingFromIndex` instead. */
export function collectThresholdPricing(
  entries: PricingEntry[],
  model: { name: string; family?: string; id: string },
): Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: { input: number; output: number; cache: { read: number; write: number } } }> | undefined {
  return collectThresholdPricingFromIndex(prepareThresholdIndex(entries), model)
}

type ModelCostLike = { input: number; output: number; cache: { read: number; write: number } }
