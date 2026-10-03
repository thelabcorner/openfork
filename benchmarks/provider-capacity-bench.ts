#!/usr/bin/env bun
/**
 * Regression benchmark for Capacity `ProviderCapacity.buildProvider`.
 *
 * Question this answers: does the bounded candidate set actually bound the
 * per-provider projection as the catalog grows, and does observed-first
 * admission survive that bounding?
 *
 * Scenarios (synthetic catalogs of 100 / 1000 / 5000 models):
 *   money — a USD balance repriced under each model's CURRENT catalog pricing
 *           (standardized workload prior + personal current price).
 *   burn  — a learned non-request resource, converted with observed burn
 *           estimates (`learnedBurnProvider`), with no money window present.
 *   admit — `capacityModelCandidates` alone, with no pricing or burn work
 *           behind it, so the admission term is attributable on its own.
 *
 * Measured per scenario:
 *   estimates  — rows in Provider.estimates (the bounded projection)
 *   bytes      — UTF-8 bytes of JSON.stringify(provider)
 *   median/p95 — wall-clock ms of a single buildProvider call
 *
 * Invariants asserted (non-zero exit on failure):
 *   1. estimates === min(MAX_PROVIDER_MODEL_ESTIMATES, catalog models) for
 *      every catalog size, so the live bound is the real bound, not a
 *      coincidence of a small catalog.
 *   2. bytes + estimate count are identical across catalog sizes — payload is
 *      flat in catalog size, which is the actual anti-O(catalog) claim.
 *   3. observed-first admission: personally observed model scopes that sort
 *      LAST by id are still inside the bound on every path.
 *   4. admission equals the reference semantics, and is independent of model
 *      insertion order, across a randomized multi-provider sweep — so the
 *      bounded ranker may only be a faster way to reach the sorted order, never
 *      a different one.
 *
 * Usage:
 *   bun run benchmarks/provider-capacity-bench.ts
 *   bun run benchmarks/provider-capacity-bench.ts --n 50 --warmup 10
 *   bun run benchmarks/provider-capacity-bench.ts --sizes 100,1000,5000
 *   bun run benchmarks/provider-capacity-bench.ts --sweep 20000
 */

import { parseArgs } from "util"
// Relative imports: `@opencode-ai/*` only resolves from inside a package that
// declares it, and this harness intentionally lives at the repo root next to
// the other benchmark scripts.
import { observeYieldStatistic } from "../packages/core/src/usage/yield-statistics"
import * as ProviderCapacity from "../packages/opencode/src/capacity/provider-capacity"
import type { BurnEstimate } from "../packages/opencode/src/capacity/resource-learning"
import type { ProviderResult, ProviderSummary } from "../packages/opencode/src/quota/schema"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    n: { type: "string", default: "25" },
    warmup: { type: "string", default: "5" },
    sizes: { type: "string", default: "100,1000,5000" },
    sweep: { type: "string", default: "2000" },
  },
  strict: false,
})

const ITERATIONS = Number(values.n)
const WARMUP = Number(values.warmup)
const SIZES = String(values.sizes)
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

if (!Number.isFinite(ITERATIONS) || ITERATIONS < 1 || !Number.isFinite(WARMUP) || WARMUP < 0 || SIZES.length === 0) {
  console.error("n >= 1, warmup >= 0, and at least one positive --sizes value are required")
  process.exit(1)
}

const PROVIDER_ID = "bench-provider"
const AT = 1_000
const RESET_AT = 2_000
const BOUND = ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES
const OBSERVED_COUNT = 5
const BURN_COVERAGE = 256
const OBSERVATIONS = 8

const modelID = (index: number) => `model-${String(index).padStart(5, "0")}`

// Deterministic pseudo-random pricing keyed on the model ID, never on the
// catalog position: the same id must reprice identically in the 100- and
// 5000-model catalogs, otherwise payload bytes would differ for a reason that
// has nothing to do with the bound.
const hash = (value: string) => {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return h >>> 0
}
const rate = (id: string, salt: number) => Number((0.25 + ((hash(id) + salt * 1013904223) % 3000) / 1000).toFixed(6))
// Every fifth model publishes no pricing, exercising the honest `learning` row
// instead of an invented request count.
const priced = (index: number) => index % 5 !== 0

function syntheticCatalog(size: number) {
  const models: Record<string, any> = {}
  for (let index = 0; index < size; index++) {
    const id = modelID(index)
    models[id] = {
      id,
      name: `Bench Model ${index}`,
      release_date: "2026-01-01",
      attachment: false,
      reasoning: index % 3 === 0,
      temperature: true,
      tool_call: true,
      ...(priced(index)
        ? {
            cost: {
              input: rate(id, 1),
              output: rate(id, 2),
              cache_read: rate(id, 3) / 10,
              cache_write: rate(id, 4),
            },
          }
        : {}),
      limit: { context: 200_000, output: 8_000 },
    }
  }
  return { [PROVIDER_ID]: { name: "Bench Provider", env: [], npm: "@ai-sdk/openai-compatible", models } } as any
}

// Observed scopes are the LAST priced models in the catalog, so plain
// provider/id order would push every one of them outside the bound. Admitting
// them is therefore the only way these can appear at all.
const observedIndexes = (size: number) => {
  const picked: number[] = []
  for (let index = size - 1; index >= 0 && picked.length < OBSERVED_COUNT; index--) {
    if (priced(index)) picked.push(index)
  }
  return picked.sort((a, b) => a - b)
}

function syntheticEntries(size: number) {
  return observedIndexes(size).map((index) => {
    const baseModelID = modelID(index)
    let state: any
    for (let n = 0; n < OBSERVATIONS; n++) {
      state = observeYieldStatistic(state, {
        sessionID: `s${n}`,
        completedAt: 900 - n,
        tokens: {
          input: 30_000 + n * 100,
          cacheRead: 5_000,
          cacheWrite: 0,
          output: 6_000 + n * 10,
          reasoning: 0,
        },
      })
    }
    return { key: { providerID: PROVIDER_ID, baseModelID }, state, updatedAt: 900 }
  })
}

function syntheticBurns(size: number): BurnEstimate[] {
  const covered = Math.min(size, Math.max(BOUND, BURN_COVERAGE))
  const burns: BurnEstimate[] = []
  for (let index = 0; index < covered; index++) {
    burns.push({
      quotaProviderID: PROVIDER_ID,
      windowKey: "5h",
      providerID: PROVIDER_ID,
      modelID: modelID(index),
      resourceKind: "tokens",
      unit: "token",
      burnPerRequest: 25_000 + index,
      observations: 12,
      effectiveSamples: 9,
      updatedAt: 900,
    })
  }
  // Provider-wide fallback burn (modelID undefined): useful shrinkage evidence,
  // but explicitly not model-personalized.
  burns.push({
    quotaProviderID: PROVIDER_ID,
    windowKey: "5h",
    providerID: PROVIDER_ID,
    resourceKind: "tokens",
    unit: "token",
    burnPerRequest: 40_000,
    observations: 40,
    effectiveSamples: 22,
    updatedAt: 900,
  })
  // Observed tail models keep their own exact burn so admission is observable.
  for (const index of observedIndexes(size)) {
    burns.push({
      quotaProviderID: PROVIDER_ID,
      windowKey: "5h",
      providerID: PROVIDER_ID,
      modelID: modelID(index),
      resourceKind: "tokens",
      unit: "token",
      burnPerRequest: 31_000,
      observations: 8,
      effectiveSamples: 6,
      updatedAt: 900,
    })
  }
  return burns
}

const summary: ProviderSummary = {
  providerId: PROVIDER_ID,
  providerName: "Bench Provider",
  aliases: [],
  configured: true,
}

const moneyResult: ProviderResult = {
  providerId: PROVIDER_ID,
  providerName: "Bench Provider",
  ok: true,
  configured: true,
  planLabel: null,
  usage: {
    windows: {
      credits: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAt: RESET_AT,
        resetAfterSeconds: 1,
        valueLabel: "$25",
        resource: { kind: "money", unit: "USD", currency: "USD", used: null, remaining: 25, limit: null },
      },
    },
  },
  fetchedAt: AT,
}

const burnResult: ProviderResult = {
  providerId: PROVIDER_ID,
  providerName: "Bench Provider",
  ok: true,
  configured: true,
  planLabel: null,
  usage: {
    windows: {
      "5h": {
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: 18_000,
        resetAt: RESET_AT,
        resetAfterSeconds: 1,
        valueLabel: null,
        resource: {
          kind: "tokens",
          unit: "token",
          used: 400_000_000,
          remaining: 600_000_000,
          limit: 1_000_000_000,
        },
      },
    },
  },
  fetchedAt: AT,
}

function median(values: readonly number[]) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function p95(values: readonly number[]) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!
}

const encoder = new TextEncoder()
const serializedBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength

type Measurement = {
  path: "money" | "burn"
  size: number
  estimates: number
  ready: number
  learning: number
  personalized: number
  bytes: number
  median: number
  p95: number
}

function measure(input: {
  path: "money" | "burn"
  size: number
  result: ProviderResult
  catalog: Record<string, any>
  entries: ReturnType<typeof syntheticEntries>
  burns: BurnEstimate[]
}) {
  for (let n = 0; n < WARMUP; n++) {
    ProviderCapacity.buildProvider({
      summary,
      result: input.result,
      catalog: input.catalog,
      entries: input.entries,
      burns: input.burns,
      at: AT,
    })
  }

  const durations: number[] = []
  let last: ProviderCapacity.Provider | undefined
  for (let n = 0; n < ITERATIONS; n++) {
    const started = performance.now()
    last = ProviderCapacity.buildProvider({
      summary,
      result: input.result,
      catalog: input.catalog,
      entries: input.entries,
      burns: input.burns,
      at: AT,
    })
    durations.push(performance.now() - started)
  }

  const provider = last!
  const estimates = provider.estimates
  return {
    path: input.path,
    size: input.size,
    estimates: estimates.length,
    ready: estimates.filter((estimate) => estimate.status === "ready").length,
    learning: estimates.filter((estimate) => estimate.status === "learning").length,
    personalized: estimates.filter((estimate) => estimate.personalized).length,
    bytes: serializedBytes(provider),
    median: median(durations)!,
    p95: p95(durations)!,
    provider,
  } satisfies Measurement & { provider: ProviderCapacity.Provider }
}

const failures: string[] = []
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}

const rows: Measurement[] = []
const results: {
  path: "money" | "burn"
  size: number
  observed: string[]
  fill: string[]
}[] = []

for (const size of SIZES) {
  const catalog = syntheticCatalog(size)
  const entries = syntheticEntries(size)
  const burns = syntheticBurns(size)
  const observed = observedIndexes(size).map(modelID)

  for (const path of ["money", "burn"] as const) {
    const measurement = measure({
      path,
      size,
      result: path === "money" ? moneyResult : burnResult,
      catalog,
      entries,
      burns,
    })
    const { provider, ...row } = measurement
    rows.push(row)

    const expected = Math.min(BOUND, size)
    check(
      row.estimates === expected,
      `${path}/${size}: expected ${expected} estimates (min(${BOUND}, ${size})), got ${row.estimates}`,
    )
    check(
      row.estimates <= BOUND,
      `${path}/${size}: estimate count ${row.estimates} exceeded the live bound ${BOUND}`,
    )

    const present = new Set(provider.estimates.map((estimate) => estimate.modelID))
    for (const id of observed) {
      check(present.has(id), `${path}/${size}: observed model ${id} was not admitted inside the bound`)
    }
    results.push({
      path,
      size,
      observed,
      fill: [...present].filter((id) => !observed.includes(id)).sort((a, b) => a.localeCompare(b)),
    })
    if (path === "money") {
      check(
        row.personalized >= Math.min(observed.length, size),
        `${path}/${size}: expected at least ${observed.length} personalized rows, got ${row.personalized}`,
      )
    }
  }
}

for (const path of ["money", "burn"] as const) {
  const group = rows.filter((row) => row.path === path)
  const baseline = group[0]
  if (!baseline) continue
  const baselineFill = results.find((item) => item.path === path && item.size === baseline.size)!.fill.join(",")
  for (const row of group.slice(1)) {
    check(
      row.estimates === baseline.estimates,
      `${path}: estimate count grew with catalog size (${baseline.size}:${baseline.estimates} -> ${row.size}:${row.estimates})`,
    )
    const fill = results.find((item) => item.path === path && item.size === row.size)!.fill.join(",")
    check(
      fill === baselineFill,
      `${path}: deterministic catalog-order fill changed with catalog size (${baseline.size} -> ${row.size})`,
    )
  }
  // Payload is flat in catalog size. It is NOT byte-identical by construction:
  // the observed-first rows legitimately differ per catalog (different tail
  // ids => different repricing), so bound the drift instead of demanding zero.
  const bytes = group.map((row) => row.bytes)
  const drift = (Math.max(...bytes) - Math.min(...bytes)) / Math.min(...bytes)
  check(drift <= 0.02, `${path}: payload drifted ${(drift * 100).toFixed(2)}% across catalog sizes (bound 2%)`)
}

// ---------------------------------------------------------------------------
// Admission on its own
// ---------------------------------------------------------------------------

/**
 * Reference admission semantics, written out independently of the
 * implementation: the sorted order the bounded ranker is required to reproduce —
 * observed scopes first, then the deterministic provider/id remainder, hard
 * capped. Deliberately naive (it materializes and sorts the whole catalog) so
 * it can act as an oracle for an admission path that must not.
 *
 * The limit is read through the production normalizer rather than re-derived, so
 * "a requested limit may only narrow the hard cap" has exactly one owner and the
 * oracle cannot drift from it. What this oracle still checks independently is the
 * ORDER: that the bounded ranker reaches the same sequence a full sort would.
 */
function admittedScopes(input: {
  providerIDs: readonly string[]
  catalog: Record<string, any>
  entries: readonly { key: { providerID: string; baseModelID: string; accountID?: string } }[]
  limit?: number
}) {
  const limit = ProviderCapacity.normalizedCapacityModelLimit(input.limit)
  if (limit === 0) return []
  const observed = new Set(
    input.entries.flatMap((entry) =>
      entry.key.accountID ? [] : [`${entry.key.providerID}:${entry.key.baseModelID}`],
    ),
  )
  const all: { providerID: string; modelID: string; observed: boolean }[] = []
  for (const providerID of input.providerIDs) {
    const provider = input.catalog[providerID]
    if (!provider) continue
    for (const model of Object.values(provider.models as Record<string, { id: string }>)) {
      all.push({ providerID, modelID: model.id, observed: observed.has(`${providerID}:${model.id}`) })
    }
  }
  all.sort(
    (a, b) =>
      Number(b.observed) - Number(a.observed) ||
      a.providerID.localeCompare(b.providerID) ||
      a.modelID.localeCompare(b.modelID),
  )
  return all.slice(0, limit)
}

const admittedJSON = (input: Parameters<typeof ProviderCapacity.capacityModelCandidates>[0]) =>
  JSON.stringify(
    ProviderCapacity.capacityModelCandidates(input).map((candidate) => ({
      providerID: candidate.providerID,
      modelID: candidate.model.id,
      observed: candidate.observed,
    })),
  )

const admissionRows: { size: number; admitted: number; median: number; p95: number }[] = []

for (const size of SIZES) {
  const catalog = syntheticCatalog(size)
  const entries = syntheticEntries(size)
  const input = { providerIDs: [PROVIDER_ID], catalog, entries: entries as any }

  check(
    admittedJSON(input) === JSON.stringify(admittedScopes(input)),
    `admit/${size}: bounded admission diverged from the reference observed-first/provider-id order`,
  )

  for (let n = 0; n < WARMUP; n++) ProviderCapacity.capacityModelCandidates(input)
  const durations: number[] = []
  for (let n = 0; n < ITERATIONS; n++) {
    const started = performance.now()
    ProviderCapacity.capacityModelCandidates(input)
    durations.push(performance.now() - started)
  }
  admissionRows.push({
    size,
    admitted: ProviderCapacity.capacityModelCandidates(input).length,
    median: median(durations)!,
    p95: p95(durations)!,
  })
}

check(
  admissionRows.every((row) => row.admitted === Math.min(BOUND, row.size)),
  `admit: candidate count is not min(${BOUND}, catalog models) for every size`,
)

/**
 * Randomized admission sweep: multi-provider catalogs, mixed-case ids where
 * locale-aware ordering differs from code-unit ordering, repeated provider ids,
 * account-scoped entries, and degenerate limits. Both properties asserted here
 * are contract, not implementation detail — bounded admission must equal the
 * reference order, and must not depend on where a model sits in the catalog
 * record.
 */
const SWEEP_PROVIDERS = ["opencode", "openrouter", "Anthropic", "a-provider", "Zed", "openai"]
const SWEEP_IDS = [
  "model-000",
  "model-00",
  "model-1",
  "Model-2",
  "MODEL-3",
  "a",
  "A",
  "b",
  "zeta",
  "Zeta",
  "zebra",
  "apple",
  "0",
  "éclair",
]
let sweepSeed = 0x2f6e2b1
const sweepRandom = () => {
  sweepSeed ^= sweepSeed << 13
  sweepSeed ^= sweepSeed >>> 17
  sweepSeed ^= sweepSeed << 5
  sweepSeed >>>= 0
  return sweepSeed / 0x100000000
}
const sweepPick = <T,>(items: readonly T[]) => items[Math.floor(sweepRandom() * items.length)]!

const SWEEP_ROUNDS = Number(values.sweep ?? 2000)
const SWEEP_LIMITS: (number | undefined)[] = [
  undefined,
  0,
  1,
  2,
  3,
  7,
  BOUND,
  BOUND + 1,
  500,
  -5,
  Number.NaN,
]

for (let round = 0; round < SWEEP_ROUNDS; round++) {
  const catalog: Record<string, any> = {}
  const providerIDs: string[] = []
  for (let p = 0, n = 1 + Math.floor(sweepRandom() * 3); p < n; p++) {
    const providerID = sweepPick(SWEEP_PROVIDERS)
    providerIDs.push(providerID)
    if (catalog[providerID]) continue
    const models: Record<string, any> = {}
    for (let m = 0, count = Math.floor(sweepRandom() * 40); m < count; m++) {
      // Values repeat ids across distinct keys, so duplicate model ids are part
      // of the input space rather than something the sweep quietly avoids.
      models[`${sweepPick(SWEEP_IDS)}#${m}`] = { id: sweepPick(SWEEP_IDS), name: `sweep-${m}` }
    }
    catalog[providerID] = { name: providerID, env: [], npm: "x", models }
  }
  const entries = Array.from({ length: Math.floor(sweepRandom() * 8) }, () => {
    const accountID = sweepRandom() < 0.3 ? `acct-${Math.floor(sweepRandom() * 3)}` : undefined
    return {
      key: {
        providerID: sweepPick(SWEEP_PROVIDERS),
        baseModelID: sweepPick(SWEEP_IDS),
        ...(accountID ? { accountID } : {}),
      },
    }
  })
  const limit = sweepPick(SWEEP_LIMITS)
  const shared = {
    providerIDs,
    catalog,
    entries,
    ...(limit !== undefined ? { limit } : {}),
  }
  const expected = JSON.stringify(admittedScopes(shared))
  const admitted = admittedJSON(shared as any)
  if (admitted !== expected) {
    check(false, `sweep round ${round}: bounded admission diverged from the reference order (limit=${limit})`)
    break
  }
  const reordered: Record<string, any> = {}
  for (const [providerID, provider] of Object.entries(catalog)) {
    reordered[providerID] = { ...provider, models: Object.fromEntries(Object.entries(provider.models).reverse()) }
  }
  if (admittedJSON({ ...shared, catalog: reordered } as any) !== admitted) {
    check(false, `sweep round ${round}: admitted set depends on model insertion order`)
    break
  }
}

const pad = (value: string | number, width: number) => String(value).padStart(width)
console.log(
  `ProviderCapacity.buildProvider — bound=${BOUND} iterations=${ITERATIONS} warmup=${WARMUP} node=${process.version} bun=${Bun.version}`,
)
console.log(
  ["path", "models", "estimates", "ready", "learning", "person.", "bytes", "median ms", "p95 ms"].join(" | "),
)
for (const row of rows) {
  console.log(
    [
      row.path,
      pad(row.size, 6),
      pad(row.estimates, 9),
      pad(row.ready, 5),
      pad(row.learning, 8),
      pad(row.personalized, 7),
      pad(row.bytes, 5),
      pad(row.median.toFixed(4), 9),
      pad(row.p95.toFixed(4), 6),
    ].join(" | "),
  )
}

for (const path of ["money", "burn"] as const) {
  const group = rows.filter((row) => row.path === path)
  const first = group[0]
  const last = group.at(-1)!
  if (!first) continue
  console.log(
    `scaling ${path} ${first.size} -> ${last.size} models: estimates ${(last.estimates / first.estimates).toFixed(2)}x  bytes ${(last.bytes / first.bytes).toFixed(2)}x  median ${(last.median / first.median).toFixed(2)}x`,
  )
}

console.log("")
console.log(`candidate admission only (capacityModelCandidates), ${SWEEP_ROUNDS} randomized equivalence rounds:`)
console.log(["admit", "models", "admitted", "median ms", "p95 ms"].join(" | "))
for (const row of admissionRows) {
  console.log(
    [
      "admit",
      pad(row.size, 6),
      pad(row.admitted, 9),
      pad(row.median.toFixed(4), 9),
      pad(row.p95.toFixed(4), 6),
    ].join(" | "),
  )
}
const admitFirst = admissionRows[0]
const admitLast = admissionRows.at(-1)!
if (admitFirst) {
  console.log(
    `scaling admit ${admitFirst.size} -> ${admitLast.size} models: median ${(admitLast.median / admitFirst.median).toFixed(2)}x`,
  )
}

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nPASS — bound, flat payload, observed-first admission, and reference-order equivalence hold across ${SIZES.length} catalog sizes and ${SWEEP_ROUNDS} randomized admission rounds.`)