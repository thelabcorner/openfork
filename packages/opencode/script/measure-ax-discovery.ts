/**
 * Source-level AX discovery microbenchmark (no model calls, no OXP host).
 * Run: bun packages/opencode/script/measure-ax-discovery.ts
 *
 * Uses the actual 33-capability prose table and reviewed Swarm action names.
 * Numbers measure warm in-process CPU ranking, excluding IPC, networking,
 * serialization, module startup, tokenizer usage, and model task success.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"

const catalog = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({
  id,
  description,
  ...(id === "openfork_swarm" ? { focusActions: SWARM_FOCUSED_ACTIONS } : {}),
}))
const queries = ["batch workers", "JSON patches", "find symbol references", "restore checkpoint", "git status history"]
const iterations = 10_000

function legacy(query: string) {
  const terms = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return catalog.filter((item) =>
    terms.every((term) => (item.id + " " + item.description).toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").includes(term)),
  ).sort((a, b) => a.id.localeCompare(b.id))
}

function measure(run: (query: string) => unknown) {
  for (let n = 0; n < 1_000; n++) run(queries[n % queries.length]!)
  const samples = new Array<number>(iterations)
  for (let n = 0; n < iterations; n++) {
    const start = performance.now()
    run(queries[n % queries.length]!)
    samples[n] = performance.now() - start
  }
  samples.sort((a, b) => a - b)
  const total = samples.reduce((sum, sample) => sum + sample, 0)
  return {
    medianMs: samples[Math.floor(iterations / 2)],
    p95Ms: samples[Math.floor(iterations * .95)],
    meanMs: total / iterations,
  }
}

const report = {
  label: "agent-experience lexical retrieval",
  provenance: "source catalog, CPU-only warm microbenchmark, not agent E2E",
  catalogSize: catalog.length,
  iterations,
  baseline: measure(legacy),
  candidate: measure((query) => rankCapabilities(catalog, query)),
  queryResults: Object.fromEntries(queries.map((query) => [query, rankCapabilities(catalog, query).slice(0, 4).map((row) => row.id)])),
}
console.log(JSON.stringify(report, null, 2))
