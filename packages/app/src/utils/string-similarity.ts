// Generic model-name fuzzy matching — used to infer a free/unpriced model's
// likely paid sibling (e.g. "Hy3" vs "Hy3 (Free)") when no exact model-id
// match exists across providers. No third-party dependency: bigram Dice
// coefficient is small, deterministic, and accurate enough for short model
// names, which is all this ever compares.

// Trailing marketing/tier noise that should not affect identity: strips
// repeatedly so "Hy3 (Free) (Beta)" reduces the same as "Hy3 Free Beta".
// Generalizes the two one-off suffix strippers that already existed
// (dialog-select-model-unpaid-v2.tsx's free/unlimited stripper,
// usage-model-identity.ts's (latest) stripper) into one canonical pass.
const TRAILING_NOISE = /[\s]*[([]?\s*(?:free|unlimited|beta|preview|latest)\s*[)\]]?\s*$/i

/** Lowercases, strips trailing free/unlimited/beta/preview/latest noise, then
 * strips all non-alphanumeric characters — the shared identity key used by
 * both exact and fuzzy model-name comparisons in this app. */
export function normalizeModelName(value: string): string {
  let normalized = value.trim()
  let previous: string
  do {
    previous = normalized
    normalized = normalized.replace(TRAILING_NOISE, "").trim()
  } while (normalized !== previous && normalized.length > 0)
  return normalized.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Bigram counts for one string.
 *
 * Exported so callers that compare the SAME string against many partners (see
 * `buildFuzzyPricingFallbackMap`, which is O(unpriced x paid)) can hoist this
 * out of their inner loop. It allocates one Map plus one string per bigram, so
 * recomputing it per comparison dominates the cost of a bulk fuzzy pass.
 */
export function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i < value.length - 1; i++) {
    const gram = value.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/**
 * Multiset bigram intersection: each shared bigram is consumed up to the number
 * of times it appears in BOTH strings.
 *
 * Equivalent to the consume-once loop inside `similarity`, but reads both maps
 * without mutating them — so precomputed counts can be reused across every
 * comparison instead of rebuilt per pair. Iterates the smaller map.
 */
export function bigramIntersection(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const [gram, count] of small) {
    const other = large.get(gram)
    if (other !== undefined) intersection += count < other ? count : other
  }
  return intersection
}

/**
 * Dice coefficient over precomputed bigram counts. Identical result to
 * `similarity(a, b)` — same early-outs, same consume-once multiset semantics —
 * but allocation-free per call, so a bulk O(n x m) pass can hoist `bigramCounts`
 * out of its inner loop.
 */
export function similarityWithCounts(
  a: string,
  countsA: Map<string, number>,
  b: string,
  countsB: Map<string, number>,
): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  return (2 * bigramIntersection(countsA, countsB)) / (a.length - 1 + (b.length - 1))
}

/** Dice's coefficient over character bigrams: 2*|intersection| / (|bigrams(a)|+|bigrams(b)|), 0..1.
 * Multiset intersection (each shared bigram consumed once) avoids overcounting repeats.
 * Strings shorter than 2 chars have no bigrams and fall back to exact equality. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const countsA = bigramCounts(a)
  const totalA = a.length - 1
  const totalB = b.length - 1
  let intersection = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2)
    const remaining = countsA.get(gram) ?? 0
    if (remaining > 0) {
      intersection++
      countsA.set(gram, remaining - 1)
    }
  }
  return (2 * intersection) / (totalA + totalB)
}

/** Best-scoring candidate at/above `threshold` (default 0.75), or undefined. Linear scan. */
export function bestMatch<T>(
  query: string,
  candidates: T[],
  key: (candidate: T) => string,
  threshold = 0.75,
): { candidate: T; score: number } | undefined {
  let best: { candidate: T; score: number } | undefined
  for (const candidate of candidates) {
    const score = similarity(query, key(candidate))
    if (score >= threshold && (!best || score > best.score)) best = { candidate, score }
  }
  return best
}
