import { buildFileTreeV2Model, createIncrementalSearchFileTreeRows, flattenFileTreeV2 } from "../src/components/file-tree-v2-model"
import { createIndexedSearchFileTreeRows } from "../src/components/project-explorer-indexed-search"

// bun scripts/bench-project-explorer-indexed-search.ts
const model = buildFileTreeV2Model(Array.from({ length: 50_000 }, (_, i) =>
  `src/group-${i % 100}/file-${i}.ts`))
const dense = createIncrementalSearchFileTreeRows(model, new Set())
const indexed = createIndexedSearchFileTreeRows(model, new Set())
const samples = { dense: [] as number[], indexed: [] as number[] }
let collapsed = new Set<string>()
for (let n = 0; n < 200; n++) {
  const path = `src/group-${n % 100}`
  collapsed = new Set(collapsed)
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
  let start = performance.now()
  dense.update(collapsed)
  samples.dense.push(performance.now() - start)
  start = performance.now()
  indexed.update(collapsed)
  samples.indexed.push(performance.now() - start)
  if (n % 25 === 0) {
    const expected = flattenFileTreeV2(model, (dir) => !collapsed.has(dir))
    if (expected.length !== indexed.length || indexed.length !== dense.rows().length)
      throw Error("Indexed search projection count mismatch")
    for (let i = 0; i < expected.length; i += 417) {
      if (expected[i]?.node.path !== indexed.at(i)?.node.path) throw Error("Indexed search preorder mismatch")
    }
  }
}
const describe = (values: number[]) => {
  const sorted = values.toSorted((a,b) => a-b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length/2)]!.toFixed(4)),
    p95Ms: Number(sorted[Math.floor(sorted.length*.95)]!.toFixed(4)),
    maximumMs: Number(sorted.at(-1)!.toFixed(4)),
  }
}
console.log(JSON.stringify({
  corpus: model.total,
  toggles: samples.dense.length,
  denseArray: describe(samples.dense),
  indexedView: describe(samples.indexed),
  count: indexed.length,
  chunks: indexed.chunkCount,
  caveat: "Bun isolated search view collapse toggles; not desktop input-to-paint",
}, null, 2))
