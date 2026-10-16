import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import * as Capability from "@/tool/capability"
import * as CodeSchema from "@/code/schema"
import * as CodeService from "@/code/service"
import { PreparedProgramCache } from "@/code/prepared"
import { DESCRIPTION } from "@/tool/code"

type Sample = {
  readonly name: string
  readonly n?: number
  readonly metric: string
  readonly unit: string
  readonly value: number
}

const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const percentile = (values: readonly number[], p: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]!
}

const timed = <T>(run: () => T) => {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

const registration = (index: number): Capability.Registration => {
  const id = `bench_tool_${index.toString().padStart(6, "0")}`
  return {
    identity: Capability.nativeIdentity(id),
    kind: "native",
    description: `Synthetic benchmark capability ${id} for Code discovery and exact lookup.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Synthetic identifier." },
        verbose: { type: "boolean", description: "Synthetic flag." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    permissionKey: id,
    invokeSemantic: () => Effect.succeed({ title: id, metadata: {}, output: "ok" }),
    authorize: () => Effect.void,
    authorityBinding: `native:${id}:v1`,
    classifyWorkspaceMutation: () => false,
    codeCallable: true,
    lifetime: "inline",
  }
}

const buildInventory = (n: number): Capability.Inventory => {
  const entries = Array.from({ length: n }, (_, index) => registration(index))
  return {
    generation: `bench-${n}`,
    searchGeneration: `bench-search-${n}`,
    entries,
    byRef: new Map(entries.map((entry) => [entry.identity.ref, entry] as const)),
  }
}

const samples: Sample[] = []

const parameterSchema = Schema.toJsonSchemaDocument(CodeSchema.Parameters).schema
const providerContract = JSON.stringify({
  id: "code",
  description: DESCRIPTION,
  parameters: parameterSchema,
})
samples.push(
  { name: "provider", metric: "description_bytes", unit: "bytes", value: bytes(DESCRIPTION) },
  { name: "provider", metric: "parameter_schema_bytes", unit: "bytes", value: bytes(JSON.stringify(parameterSchema)) },
  { name: "provider", metric: "static_contract_bytes", unit: "bytes", value: bytes(providerContract) },
)

const sizes = [100, 1_000, 10_000, 50_000] as const
for (const n of sizes) {
  const built = timed(() => buildInventory(n))
  const inventory = built.value
  samples.push({ name: "inventory", n, metric: "build", unit: "ms", value: built.ms })

  const exactRef = inventory.entries[inventory.entries.length - 1]!.identity.ref
  const exactIterations = 20_000
  const exactStart = performance.now()
  for (let i = 0; i < exactIterations; i++) {
    if (!Capability.lookup(inventory, exactRef)) throw new Error("exact lookup failed")
  }
  samples.push({
    name: "describe",
    n,
    metric: "exact_lookup_mean",
    unit: "us/op",
    value: ((performance.now() - exactStart) * 1_000) / exactIterations,
  })

  // Distinct queries force cold ranking while the shared "bench" token makes
  // every descriptor participate in scoring/sorting (intentional worst case).
  const cold: number[] = []
  for (let i = 0; i < 12; i++) {
    const query = `bench cold${i}`
    const start = performance.now()
    CodeService.search(inventory, { query, target: "callable", limit: 8 })
    cold.push(performance.now() - start)
  }
  samples.push(
    { name: "search", n, metric: "cold_p50", unit: "ms", value: percentile(cold, 0.5) },
    { name: "search", n, metric: "cold_p95", unit: "ms", value: percentile(cold, 0.95) },
  )

  // Populate once, then measure the generation-local cached ranking.
  CodeService.search(inventory, { query: "bench warm", target: "callable", limit: 8 })
  const warm: number[] = []
  for (let i = 0; i < 100; i++) {
    const start = performance.now()
    CodeService.search(inventory, { query: "bench warm", target: "callable", limit: 8 })
    warm.push(performance.now() - start)
  }
  samples.push(
    { name: "search", n, metric: "warm_p50", unit: "ms", value: percentile(warm, 0.5) },
    { name: "search", n, metric: "warm_p95", unit: "ms", value: percentile(warm, 0.95) },
  )

  // Production reconstructs capability inventories across provider actions.
  // A stable content-derived searchGeneration must preserve the cached ranking
  // even when the inventory object/cursor generation is fresh.
  const reconstructed: number[] = []
  for (let i = 0; i < 100; i++) {
    const next: Capability.Inventory = {
      generation: `bench-${n}-reconstructed-${i}`,
      searchGeneration: inventory.searchGeneration,
      entries: inventory.entries,
      byRef: inventory.byRef,
    }
    const start = performance.now()
    CodeService.search(next, { query: "bench warm", target: "callable", limit: 8 })
    reconstructed.push(performance.now() - start)
  }
  samples.push(
    { name: "search", n, metric: "warm_reconstructed_p50", unit: "ms", value: percentile(reconstructed, 0.5) },
    { name: "search", n, metric: "warm_reconstructed_p95", unit: "ms", value: percentile(reconstructed, 0.95) },
  )
}

PreparedProgramCache.resetForTest()
const source = `
type Item = { id: string; value: number }
const items: Item[] = Array.isArray(input.items) ? input.items : []
const active = items.filter((item) => item.value > 0)
const total = active.reduce((sum, item) => sum + item.value, 0)
if (input.lookup) {
  const detail = await call("native:bench_tool_000001", { id: String(input.lookup), verbose: false })
  return { total, detail }
}
return { total, count: active.length }
`
const sourceHash = `sha256:${sha256(source)}`
const coldPrepared = timed(() => PreparedProgramCache.get(source, sourceHash))
samples.push({ name: "prepared", metric: "cold_prepare", unit: "ms", value: coldPrepared.ms })

const prepareHitIterations = 20_000
const hitStart = performance.now()
for (let i = 0; i < prepareHitIterations; i++) PreparedProgramCache.get(source, sourceHash)
samples.push({
  name: "prepared",
  metric: "cache_hit_mean",
  unit: "us/op",
  value: ((performance.now() - hitStart) * 1_000) / prepareHitIterations,
})
const cache = PreparedProgramCache.stats()
samples.push(
  { name: "prepared", metric: "cache_entries", unit: "count", value: cache.entries },
  { name: "prepared", metric: "cache_source_bytes", unit: "bytes", value: cache.sourceBytes },
)

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), samples }, null, 2))
  process.exit(0)
}

console.log("Code Tool synthetic performance benchmark")
console.log("========================================")
for (const sample of samples) {
  const scope = sample.n === undefined ? sample.name : `${sample.name} n=${sample.n}`
  const digits = sample.unit === "bytes" || sample.unit === "count" ? 0 : sample.unit === "us/op" ? 3 : 3
  console.log(`${scope.padEnd(22)} ${sample.metric.padEnd(24)} ${sample.value.toFixed(digits)} ${sample.unit}`)
}
