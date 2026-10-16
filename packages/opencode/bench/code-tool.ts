/**
 * Code Tool discovery performance harness.
 *
 *   bun bench/code-tool.ts
 *
 * Measures provider-hidden discovery work only. The provider-visible code schema
 * is static and is not regenerated here.
 */
import { performance } from "node:perf_hooks"
import { Effect } from "effect"
import * as Capability from "../src/tool/capability"
import * as CodeService from "../src/code/service"

const inputSchema = {
  type: "object" as const,
  properties: { value: { type: "string" as const } },
}

function registration(index: number): Capability.Registration {
  const id = `synthetic_tool_${String(index).padStart(6, "0")}`
  return {
    identity: Capability.nativeIdentity(id),
    kind: "native",
    description: `Synthetic benchmark capability ${index} for code discovery`,
    inputSchema,
    authorize: () => Effect.void,
    invokeSemantic: () => Effect.succeed({ title: id, metadata: {}, output: "ok" }),
    authorityBinding: `native:${id}:bench-v1`,
    classifyWorkspaceMutation: () => false,
    codeCallable: true,
    lifetime: "inline",
  }
}

function inventory(size: number): Capability.Inventory {
  const entries = Array.from({ length: size }, (_, index) => registration(index))
  return {
    generation: `bench-${size}`,
    entries,
    byRef: new Map(entries.map((entry) => [entry.identity.ref, entry] as const)),
  }
}

function ms(start: number) {
  return performance.now() - start
}

function percentile(values: readonly number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

const sizes = [1_000, 10_000, 50_000] as const
const results: unknown[] = []

for (const size of sizes) {
  const buildStart = performance.now()
  const snapshot = inventory(size)
  const buildMs = ms(buildStart)

  const searchStart = performance.now()
  const first = CodeService.search(snapshot, { query: "synthetic tool", limit: 25 })
  const coldSearchMs = ms(searchStart)

  const warmSamples: number[] = []
  for (let index = 0; index < 100; index++) {
    const start = performance.now()
    CodeService.search(snapshot, { query: "synthetic tool", limit: 25 })
    warmSamples.push(ms(start))
  }

  const lookupSamples: number[] = []
  const describeSamples: number[] = []
  for (let index = 0; index < 500; index++) {
    const target = snapshot.entries[(index * 7919) % size]!

    let start = performance.now()
    Capability.lookup(snapshot, target.identity.ref)
    lookupSamples.push(ms(start))

    start = performance.now()
    CodeService.describe(snapshot, target.identity.ref)
    describeSamples.push(ms(start))
  }

  results.push({
    size,
    buildMs,
    coldSearchMs,
    warmSearchP50Ms: percentile(warmSamples, 0.5),
    warmSearchP95Ms: percentile(warmSamples, 0.95),
    exactLookupP50Ms: percentile(lookupSamples, 0.5),
    exactLookupP95Ms: percentile(lookupSamples, 0.95),
    describeP50Ms: percentile(describeSamples, 0.5),
    describeP95Ms: percentile(describeSamples, 0.95),
    firstPageItems: first.items.length,
    heapUsedMiB: process.memoryUsage().heapUsed / (1024 * 1024),
  })
}

console.log(JSON.stringify({ runtime: process.version, results }, null, 2))
