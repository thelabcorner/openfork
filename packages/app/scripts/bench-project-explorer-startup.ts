import type { FileNode } from "@opencode-ai/sdk/v2"
import { createIncrementalLiveFileTreeV2 } from "../src/components/file-tree-v2-model"
import { createIndexedLiveFileTreeV2 } from "../src/components/project-explorer-indexed-live"

/**
 * Run with bun scripts/bench-project-explorer-startup.ts
 * Unloaded remote folders are not listed by this fixture. Dense and indexed
 * structures consume the same already-loaded authoritative node graph.
 */
const summary = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return { medianMs: +sorted[Math.floor(sorted.length/2)]!.toFixed(3), p95Ms: +sorted[Math.floor(sorted.length*.95)]!.toFixed(3) }
}
const samples = []
for (const count of [1_000, 10_000, 50_000]) {
  const folders = Math.min(100, Math.ceil(count / 50))
  const members = new Map<string, FileNode[]>()
  const nodes = new Map<string, FileNode>()
  const make = (path: string, type: "directory" | "file"): FileNode => ({
    path, name: path.split("/").at(-1)!, absolute: "/work/" + path, type, ignored: false,
  })
  const roots = Array.from({ length: folders }, (_, i) => make(`folder-${i}`, "directory"))
  members.set("", roots)
  roots.forEach((node) => nodes.set(node.path, node))
  const leavesPerFolder = Math.max(1, Math.floor((count - folders) / folders))
  for (const root of roots) {
    const leaves = Array.from({ length: leavesPerFolder }, (_, i) => make(`${root.path}/file-${i}.ts`, "file"))
    leaves.forEach((node) => nodes.set(node.path, node))
    members.set(root.path, leaves)
  }
  const children = (path: string) => members.get(path) ?? []
  const expanded = () => true
  const lookup = (path: string) => nodes.get(path)
  const denseTimes: number[] = []
  const indexedTimes: number[] = []
  for (let n = 0; n < 7; n++) {
    const denseStart = performance.now()
    const dense = createIncrementalLiveFileTreeV2(children, expanded, lookup)
    denseTimes.push(performance.now() - denseStart)
    const indexedStart = performance.now()
    const indexed = createIndexedLiveFileTreeV2(children, expanded, lookup)
    indexedTimes.push(performance.now() - indexedStart)
    if (indexed.length !== dense.rows().length) throw Error("Wrong startup projection count")
  }
  samples.push({ totalVisibleRows: roots.length * (leavesPerFolder + 1), dense: summary(denseTimes), indexed: summary(indexedTimes) })
}
console.log(JSON.stringify({
  benchmark: "Cold projection construction from an already-loaded in-memory directory graph",
  note: "Bun isolated, sequential builds; not a desktop bootstrap throughput or UI memory benchmark",
  samples,
}, null, 2))
