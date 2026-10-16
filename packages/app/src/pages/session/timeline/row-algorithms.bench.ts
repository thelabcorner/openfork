/**
 * Reproducible CPU-only algorithm benchmark:
 *   bun src/pages/session/timeline/row-algorithms.bench.ts
 *
 * Timings exclude test-fixture construction and rebuilding the initial index.
 * Reference operations are the old public per-row removal and the old
 * map-based position-independent reconciliation (for unique user rows).
 * No hard pass/fail threshold: system load and JIT warmup vary.
 */
import { TimelineRow } from "./timeline-row"
import { createTimelineRowIndexes, indexTimelineRow, removeTimelineRowIndex, truncateTimelineRowIndexes } from "./row-index"
import { reuseTimelineRows } from "./row-reconciliation"
import { mergeVirtualIndexes } from "./virtual-items"

type Row = TimelineRow.TimelineRow
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[(sorted.length / 2) | 0]!
}
function measure(work: () => void, warmups = 3, rounds = 9) {
  for (let i = 0; i < warmups; i++) work()
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const before = performance.now()
    work()
    samples.push(performance.now() - before)
  }
  return median(samples)
}
function rows(size: number): Row[] {
  return Array.from({ length: size }, (_, i) =>
    new TimelineRow.UserMessage({ userMessageID: `user-${i}`, anchor: true }),
  )
}
function referenceReconcile(previous: Row[], current: Row[]): Row[] {
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const next = current.map((row) => {
    const old = byKey.get(TimelineRow.key(row))
    return old && TimelineRow.equals(old, row) ? old : row
  })
  return previous.length === next.length && previous.every((row, index) => row === next[index]) ? previous : next
}
function indexed(size: number) {
  const source: Row[] = Array.from({ length: size }, (_, i) =>
    new TimelineRow.AssistantPart({
      userMessageID: "big-turn",
      group: { type: "part", key: `part-${i}`, ref: { messageID: "assistant", partID: `part-${i}` }, refs: [] } as any,
      previousAssistantPart: i > 0,
    }),
  )
  const build = () => {
    const indexes = createTimelineRowIndexes()
    source.forEach((row, index) => indexTimelineRow(indexes, row, index))
    return indexes
  }
  return { source, build }
}
const report: Record<string, number>[] = []
for (const size of [1000, 5000, 20_000]) {
  const previous = rows(size)
  const current = rows(size)
  // Warm key caching equally before timing either path.
  previous.forEach(TimelineRow.key)
  current.forEach(TimelineRow.key)
  const reference = measure(() => { referenceReconcile(previous, current) })
  const optimized = measure(() => { reuseTimelineRows(previous, current) })
  report.push({ operation: 1, rows: size, referenceMs: reference, optimizedMs: optimized, speedup: reference / optimized })
}
for (const size of [1000, 5000, 20_000]) {
  const { source, build } = indexed(size)
  for (const fraction of [0, 0.5]) {
    const start = Math.floor(size * fraction)
    const old = measure(() => {
      const index = build()
      for (let i = start; i < size; i++) removeTimelineRowIndex(index, source[i]!)
    }, 1, 5)
    const newer = measure(() => {
      const index = build()
      truncateTimelineRowIndexes(index, source, start)
    }, 1, 5)
    // Includes setup on both sides. Use the separate removal-only timings
    // in the performance report for isolated algorithm speedups.
    report.push({ operation: 2, rows: size, prefixRows: start, referenceMs: old, optimizedMs: newer, speedup: old / newer })
  }
}
for (const record of report) console.log(JSON.stringify(
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
))

function referenceRangeMerge(visible: number[], pinned: number[], active: number, count: number) {
  const extras = active < 0 || active >= (pinned.at(-1) ?? -1)
    ? active < 0 ? pinned : [...pinned, active]
    : [...pinned, active].sort((a, b) => a - b)
  const output: number[] = []
  let i = 0, j = 0
  while (i < visible.length || j < extras.length) {
    const a = visible[i]
    const b = extras[j]
    if (a === undefined || (b !== undefined && b < a)) {
      if (b !== output.at(-1)) output.push(b!)
      j++
    } else {
      if (a !== output.at(-1)) output.push(a)
      i++
    }
  }
  return output.filter((index) => index >= 0 && index < count)
}
for (const pins of [0, 24, 96]) {
  const visible = Array.from({ length: 48 }, (_, i) => 10_000 + i)
  const pinned = Array.from({ length: pins }, (_, i) => 10_000 + 2 * i)
  const active = pins ? 10_000 + pins : 10_200
  const count = 50_000
  // Repeated range recalculation is a per-scroll-frame hot path.
  const loops = 12_000
  const baseline = measure(() => {
    for (let i = 0; i < loops; i++) referenceRangeMerge(visible, pinned, active, count)
  }, 2, 7)
  const optimized = measure(() => {
    for (let i = 0; i < loops; i++) mergeVirtualIndexes(visible, pinned, active, count)
  }, 2, 7)
  console.log(JSON.stringify({
    operation: "range-merge", pins, loops,
    referenceMs: +baseline.toFixed(3), optimizedMs: +optimized.toFixed(3),
    speedup: +(baseline / optimized).toFixed(2),
  }))
}
