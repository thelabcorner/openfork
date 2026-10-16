/**
 * Isolated mutation-reconciliation benchmark; not a renderer frame-time test.
 * Run from packages/app: bun run benchmarks/tab-strip-visibility.bench.ts
 *
 * Hold DOM cardinality fixed and time only observer-callback work. Both paths
 * operate on identical lists and simulate a move (remove+add in one delivery).
 * Alternate trial order, warm both implementations and report medians.
 */
import "../happydom"
import { trackTabStripVisibility } from "../src/components/titlebar-tab-visibility"

type Receiver = (records: MutationRecord[]) => void
// Optional slot count tests the small-tab tradeoff as well as large strips.
const requestedSize = Number(process.argv[2])
const size = Number.isInteger(requestedSize) && requestedSize >= 1 ? requestedSize : 512
const iterations = 2_000
const trials = 7
const selector = "[data-titlebar-tab-slot]"

function setup(incremental: boolean) {
  const scroll = document.createElement("div")
  const list = document.createElement("div")
  scroll.append(list)
  for (let index = 0; index < size; index++) {
    const node = document.createElement("div")
    node.setAttribute("data-titlebar-tab-slot", "")
    list.append(node)
  }
  let callback: Receiver = () => {}
  const Intersection = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  const Mutation = class {
    constructor(cb: MutationCallback) { callback = (records) => cb(records, {} as MutationObserver) }
    observe() {}
    disconnect() {}
  } as unknown as typeof MutationObserver

  let stop = () => {}
  if (incremental) {
    stop = trackTabStripVisibility(scroll, list, Intersection, Mutation)
  } else {
    // Preserve the old O(N)-per-mutation implementation for a fair control.
    const tracked = new Set<HTMLElement>()
    const synchronize = () => {
      const present = new Set<HTMLElement>()
      for (const child of list.children) {
        if (!(child instanceof HTMLElement) || !child.matches(selector)) continue
        present.add(child)
        if (tracked.has(child)) continue
        tracked.add(child)
      }
      for (const child of tracked) if (!present.has(child)) tracked.delete(child)
    }
    synchronize()
    callback = synchronize
  }

  const moved = list.firstElementChild!
  const record = {
    target: list,
    addedNodes: [moved],
    removedNodes: [moved],
  } as unknown as MutationRecord
  return {
    run: () => {
      const start = performance.now()
      for (let index = 0; index < iterations; index++) callback([record])
      return performance.now() - start
    },
    stop,
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const baseline: number[] = []
const optimized: number[] = []
for (let trial = -2; trial < trials; trial++) {
  const order = trial % 2 === 0 ? [false, true] : [true, false]
  for (const incremental of order) {
    const harness = setup(incremental)
    const ms = harness.run()
    harness.stop()
    if (trial < 0) continue
    ;(incremental ? optimized : baseline).push(ms)
  }
}
const oldMs = median(baseline)
const newMs = median(optimized)
console.log({
  slots: size,
  callbacksPerTrial: iterations,
  trials,
  previousMs: Number(oldMs.toFixed(3)),
  incrementalMs: Number(newMs.toFixed(3)),
  speedup: Number((oldMs / newMs).toFixed(2)),
  baselineSamples: baseline.map((value) => Number(value.toFixed(2))),
  optimizedSamples: optimized.map((value) => Number(value.toFixed(2))),
})