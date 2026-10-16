/** bun src/pages/session/timeline/virtualizer-key-identity.bench.ts
 * Isolate the TanStack measurement memo's getItemKey dependency.
 * This reproduces the former fresh-function getter versus a cached function.
 * Measure after warmup, and report median across 15 independent invocations.
 */
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from "@tanstack/solid-virtual"
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[(sorted.length / 2) | 0]!
}
function bench(count: number, unstable: boolean) {
  const key = (index: number) => `key-${index}`
  const config = {
    count,
    initialRect: { width: 800, height: 800 },
    getScrollElement: () => null,
    estimateSize: () => 45,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
  }
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    ...config, getItemKey: key,
  })
  instance.getTotalSize()
  const samples = []
  for (let i = 0; i < 19; i++) {
    // Reflect Solid adapter's setOptions sequence without scheduling DOM work.
    const before = performance.now()
    instance.setOptions({ ...config, getItemKey: unstable ? (index) => key(index) : key })
    instance.getTotalSize()
    if (i >= 4) samples.push(performance.now() - before)
  }
  return median(samples)
}
for (const rows of [10_000, 50_000, 100_000]) {
  const stable = bench(rows, false)
  const unstable = bench(rows, true)
  console.log(JSON.stringify({
    rows, stableMs: +stable.toFixed(4), unstableMs: +unstable.toFixed(4),
    speedup: +(unstable / Math.max(stable, 0.00001)).toFixed(2),
  }))
}
