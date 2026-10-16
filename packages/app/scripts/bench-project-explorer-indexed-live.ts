import type { FileNode } from "@opencode-ai/sdk/v2"
import { Virtualizer } from "@tanstack/solid-virtual"
import { createIncrementalLiveFileTreeV2 } from "../src/components/file-tree-v2-model"
import { createIndexedLiveFileTreeV2 } from "../src/components/project-explorer-indexed-live"

/**
 * Representative 1,000 visible expanded directories with 49 files each.
 * Measures changes against both the previous optimized array projection and
 * the new weighted-index projection, including complete parity checks.
 *
 * bun scripts/bench-project-explorer-indexed-live.ts
 */
const dirs = Array.from({ length: 1_000 }, (_, i) => `dir-${i}`)
const make = (path: string, type: "file" | "directory" = "file", version = 0): FileNode => ({
  name: path.split("/").at(-1)!, path, absolute: `/workspace/${path}`,
  type, ignored: false, mtime: version,
})
const groups = new Map<string, FileNode[]>()
const nodes = new Map<string, FileNode>()
const roots = dirs.map((dir) => make(dir, "directory"))
groups.set("", roots)
for (const row of roots) nodes.set(row.path, row)
for (const dir of dirs) {
  const leaves = Array.from({ length: 49 }, (_, i) => make(`${dir}/f-${i}.ts`))
  groups.set(dir, leaves)
  for (const leaf of leaves) nodes.set(leaf.path, leaf)
}
const children = (dir: string) => groups.get(dir) ?? []
const expanded = (dir: string) => dir.startsWith("dir-")
const lookup = (path: string) => nodes.get(path)
const dense = createIncrementalLiveFileTreeV2(children, expanded, lookup)
const indexed = createIndexedLiveFileTreeV2(children, expanded, lookup)

const denseMs: number[] = []
const indexedMs: number[] = []
const denseRootMs: number[] = []
const indexedRootMs: number[] = []
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(4)),
    p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(4)),
    maxMs: Number(sorted.at(-1)!.toFixed(4)),
  }
}
const current = () => {
  const expected = dense.rows()
  if (expected.length !== indexed.length) throw Error("Visible count mismatch")
  for (let i = 0; i < expected.length; i += 739) {
    if (indexed.at(i)?.node.path !== expected[i]?.node.path) throw Error(`Preorder mismatch ${i}`)
  }
}
current()

for (let tick = 0; tick < 300; tick++) {
  const dir = `dir-${tick * 7919 % 1_000}`
  const items = groups.get(dir)!.slice()
  const path = `${dir}/f-19.ts`
  const newNode = make(path, "file", tick + 1)
  items[19] = newNode
  groups.set(dir, items)
  nodes.set(path, newNode)
  const a = performance.now()
  dense.update(dir)
  denseMs.push(performance.now() - a)
  const b = performance.now()
  indexed.update(dir)
  indexedMs.push(performance.now() - b)
  if (tick % 25 === 0) current()
}
current()

for (let tick = 0; tick < 16; tick++) {
  const rootPath = `dir-${tick * 17}`
  const replacement = make(rootPath, "directory", tick + 1)
  nodes.set(rootPath, replacement)
  groups.set("", groups.get("")!.map((node) => node.path === rootPath ? replacement : node))
  const a = performance.now()
  dense.update("")
  denseRootMs.push(performance.now() - a)
  const b = performance.now()
  indexed.update("")
  indexedRootMs.push(performance.now() - b)
  current()
}

const indexedGlobalMaterialization = []
for (let i = 0; i < 8; i++) {
  const t = performance.now()
  if (indexed.rows().length !== 50_000) throw Error("Materialization mismatch")
  indexedGlobalMaterialization.push(performance.now() - t)
}
const denseSnapshot = dense.rows()
const virtualizerMeasurement = (indexedLookup: boolean) => {
  const baseline = {
    count: NODES,
    getScrollElement: () => null,
    estimateSize: () => 22,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  }
  const total: number[] = []
  const virtualizer = new Virtualizer({
    ...baseline,
    getItemKey: (i: number) => denseSnapshot[i]?.node.path ?? i,
  })
  virtualizer.getTotalSize()
  for (let iteration = 0; iteration < 7; iteration++) {
    const started = performance.now()
    const getItemKey = indexedLookup
      ? (i: number) => indexed.at(i)?.node.path ?? i
      : (i: number) => denseSnapshot[i]?.node.path ?? i
    virtualizer.setOptions({ ...baseline, getItemKey })
    virtualizer.getTotalSize()
    total.push(performance.now() - started)
  }
  return stats(total)
}
const NODES = indexed.length
console.log(JSON.stringify({
  corpus: indexed.length,
  caveat: "Bun microbenchmarks, sequential operations on shared source; not Electron frame data",
  localWatcherMetadataUpdate: { previousDenseArray: stats(denseMs), weightedIndex: stats(indexedMs) },
  rootMetadataUpdate: { previousDenseArray: stats(denseRootMs), weightedIndex: stats(indexedRootMs) },
  indexedGlobalRowAccess: stats(indexedGlobalMaterialization),
  virtualizerRekey50k: {
    denseArray: virtualizerMeasurement(false),
    indexedRowGetter: virtualizerMeasurement(true),
  },
  indexedDepth: indexed.depth,
}, null, 2))
