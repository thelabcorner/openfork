import { IndexedRowSequence } from "../src/components/project-explorer-indexed-rows"

/**
 * Reproducible and intentionally narrow comparison of mutable indexed row
 * sequences vs dense array copy/splice. Includes construction and index reads:
 * a data structure is not a win merely because one microoperation is faster.
 *
 * bun scripts/bench-project-explorer-indexed-rows.ts
 */
const N = 50_000
const iterations = 300
type Row = { node: { path: string }; value: number }
const make = (n: number): Row => ({ node: { path: `p-${n}` }, value: n })
const corpus = Array.from({ length: N }, (_, n) => make(n))

const stats = (list: number[]) => {
  const sorted = list.toSorted((a, b) => a - b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(4)),
    p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(4)),
    maximumMs: Number(sorted.at(-1)!.toFixed(4)),
  }
}
const series = (run: () => void, count = 7) => {
  const measurements = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    run()
    measurements.push(performance.now() - start)
  }
  return stats(measurements)
}
const indexedConstruction = series(() => {
  const sequence = new IndexedRowSequence(corpus)
  if (sequence.length !== N) throw Error("Construction count mismatch")
})
const baselineDense = series(() => corpus.slice())
const singleIndex = 40_001
const arrayLookup = series(() => {
  for (let i = 0; i < 1_000; i++) {
    if (corpus.findIndex((r) => r.node.path === "p-40001") !== singleIndex) throw Error("Linear lookup")
  }
}, 5)
const sequence = new IndexedRowSequence(corpus)
const indexedLookup = series(() => {
  for (let i = 0; i < 1_000; i++) {
    if (sequence.indexOf("p-40001") !== singleIndex) throw Error("Indexed lookup")
  }
}, 5)
const arrayRandomGet = series(() => {
  for (let i = 0; i < 5_000; i++) {
    const index = i * 7919 % N
    if (corpus[index]?.value !== index) throw Error("Dense item access")
  }
}, 5)
const indexedRandomGet = series(() => {
  for (let i = 0; i < 5_000; i++) {
    const index = i * 7919 % N
    if (sequence.get(index)?.value !== index) throw Error("Indexed item access")
  }
}, 5)

const newValues = Array.from({ length: iterations }, (_, i) => make(N + i))
const arrayLocalEdits = series(() => {
  let values = corpus.slice()
  for (let i = 0; i < iterations; i++) {
    const index = 25_000
    values = values.slice(0, index).concat(newValues[i]!, values.slice(index + 1))
  }
  if (values.length !== N || values[25_000]?.value !== N + iterations - 1) throw Error("Dense splice mismatch")
}, 5)
const indexedLocalEdits = series(() => {
  const view = new IndexedRowSequence(corpus)
  for (let i = 0; i < iterations; i++) view.splice(25_000, 1, [newValues[i]!])
  if (view.length !== N || view.get(25_000)?.value !== N + iterations - 1) throw Error("Indexed splice mismatch")
}, 5)
const arrayRebuildEachTime = series(() => {
  let values = corpus.slice()
  for (let i = 0; i < 40; i++) {
    values = values.slice(0, 25_000).concat(newValues[i]!, values.slice(25_001))
    const flat = values.slice()
    if (flat.length !== N) throw Error("Dense snapshot mismatch")
  }
}, 5)
const indexedWithMaterialization = series(() => {
  const view = new IndexedRowSequence(corpus)
  for (let i = 0; i < 40; i++) {
    view.splice(25_000, 1, [newValues[i]!])
    if (view.toArray().length !== N) throw Error("Indexed snapshot mismatch")
  }
}, 5)
const retainedHeap = (() => {
  // Sampling the incremental heap delta with forced Bun GC is only an
  // approximate retained-memory comparison. Engines reserve heap pages and
  // JIT caches independently; never interpret this as an Electron RSS claim.
  const retained = (build: () => { length: number }) => {
    Bun.gc(true)
    const baseline = process.memoryUsage().heapUsed
    let kept: { length: number } | undefined = build()
    Bun.gc(true)
    const after = process.memoryUsage().heapUsed
    if (kept.length !== N) throw Error("Retained memory fixture mismatch")
    kept = undefined
    Bun.gc(true)
    return Math.max(0, after - baseline)
  }
  return {
    denseShallowCopyBytes: retained(() => corpus.slice()),
    indexedSequenceBytes: retained(() => new IndexedRowSequence(corpus)),
  }
})()
console.log(JSON.stringify({
  corpus: N, localizedOperations: iterations,
  caveat: "isolated Bun comparison, not end-to-end Electron or frame-time measurements",
  construction: { denseCopy: baselineDense, indexed: indexedConstruction },
  lookup1kTimes: { denseFindIndex: arrayLookup, indexed: indexedLookup },
  get5kTimes: { denseArray: arrayRandomGet, indexed: indexedRandomGet },
  local300Edits: { arrayCopy: arrayLocalEdits, indexed: indexedLocalEdits },
  local40EditsWithFullMaterialization: { arrayCopy: arrayRebuildEachTime, indexed: indexedWithMaterialization },
  treapDepth: sequence.maxDepth(),
  retainedHeap,
}, null, 2))
