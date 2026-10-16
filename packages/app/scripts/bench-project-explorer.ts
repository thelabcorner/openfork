/**
 * Isolated Project Explorer hot-path benchmark (no app/server startup).
 *
 * From packages/app:
 *   bun scripts/bench-project-explorer.ts
 *
 * Reports scoped data-structure costs, not end-to-end Electron frame timing.
 */
import { Virtualizer } from "@tanstack/solid-virtual"
import { buildFileTreeV2Model, createIncrementalLiveFileTreeV2, createIncrementalSearchFileTreeRows, flattenFileTreeV2, flattenLiveFileTreeV2 } from "../src/components/file-tree-v2-model"
import { buildProjectExplorerSearchTree, startProjectExplorerSearchTree } from "../src/components/project-explorer-search-tree"
import { createProjectExplorerSearchAccumulator, mergeProjectExplorerSearchPaths } from "../src/components/project-explorer-search-runner"
import { startProjectExplorerSearchTreeDelta } from "../src/components/project-explorer-search-incremental"
import type { FileTreeV2Model } from "../src/components/file-tree-v2-model"

const SIZE = 50_000
const paths = Array.from({ length: SIZE }, (_, i) => `src/file-${String(SIZE - i).padStart(5, "0")}.ts`)
const matches = new Set(paths)
const fileNodes = paths.map((path) => ({
  path,
  name: path.slice(4),
  absolute: `/workspace/${path}`,
  type: "file" as const,
  ignored: false,
}))
const byDir = (dir: string) => dir === "" ? fileNodes : []

function describe(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3)),
    minMs: Number(sorted[0]!.toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  }
}

function measure(run: () => void, count = 8) {
  run()
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return describe(samples)
}

const fullModel = buildProjectExplorerSearchTree(matches, new Set(), () => undefined, "/workspace")
const synchronousProjection = measure(() => {
  const model = buildProjectExplorerSearchTree(matches, new Set(), () => undefined, "/workspace")
  if (model.total !== SIZE + 1) throw Error("Wrong synchronous projection count")
}, 5)

const cooperativeStarted = performance.now()
const cooperative = await new Promise<{
  slices: number
  maxSliceMs: number
  totalMs: number
}>((resolve) => {
  startProjectExplorerSearchTree({
    matches, ancestors: new Set(), lookup: () => undefined,
    root: "/workspace", sliceMs: 2,
    complete: (model, metrics) => {
      if (model.total !== fullModel.total) throw Error("Wrong cooperative projection count")
      if (flattenFileTreeV2(model, () => true)[1]?.node.path !== "src/file-00001.ts") {
        throw Error("Incorrect ordering in cooperative projection")
      }
      resolve(metrics)
    },
  })
})
const cooperativeElapsedMs = performance.now() - cooperativeStarted

const flattenLoaded = measure(() => {
  if (flattenLiveFileTreeV2(byDir, () => false).length !== SIZE) throw Error("Wrong live flatten count")
})
const exampleRows = flattenLiveFileTreeV2(byDir, () => false)
const desiredRow = fileNodes[49_000]!.path
const eagerFullRowIndex = measure(() => {
  const index = new Map<string, (typeof exampleRows)[number]>()
  for (const row of exampleRows) index.set(row.node.path, row)
  if (index.get(desiredRow)?.node.path !== desiredRow) throw Error("Missing indexed row")
})
const directSingleRowLookup = measure(() => {
  if (exampleRows.find((row) => row.node.path === desiredRow)?.node.path !== desiredRow) {
    throw Error("Missing scanned row")
  }
})

// 1k directories / 49k file leaves: model one watcher refresh changing just
// one visible directory near the middle, including the cost of array splicing.
const siblingCount = 1_000
const grouped = new Map<string, typeof fileNodes>()
const directories = Array.from({ length: siblingCount }, (_, i) => ({
  path: `dir-${i}`, name: `dir-${i}`,
  absolute: `/workspace/dir-${i}`, type: "directory" as const, ignored: false,
}))
grouped.set("", directories as typeof fileNodes)
for (let i = 0; i < siblingCount; i++) {
  const dir = directories[i]!.path
  grouped.set(dir, Array.from({ length: 49 }, (_, j) => ({
    path: `${dir}/leaf-${j}.ts`, name: `leaf-${j}.ts`,
    absolute: `/workspace/${dir}/leaf-${j}.ts`, type: "file" as const, ignored: false,
  })))
}
const groupedChildren = (dir: string) => grouped.get(dir) ?? []
const expandedGroup = (dir: string) => dir.startsWith("dir-")
const incrementalView = createIncrementalLiveFileTreeV2(groupedChildren, expandedGroup)
const localChange = () => {
  const dir = "dir-500"
  const old = grouped.get(dir)!
  grouped.set(dir, old.toReversed())
}
const fullLocalRefresh = measure(() => {
  localChange()
  if (flattenLiveFileTreeV2(groupedChildren, expandedGroup).length !== 50_000) throw Error("Full view missing rows")
}, 10)
const incrementalLocalRefresh = measure(() => {
  localChange()
  if (incrementalView.update("dir-500").length !== 50_000) throw Error("Incremental view missing rows")
}, 10)
if (incrementalView.rows().map((r) => r.node.path).join("|") !==
  flattenLiveFileTreeV2(groupedChildren, expandedGroup).map((r) => r.node.path).join("|")) {
  throw Error("Incremental refresh diverged from a full flatten")
}

let rootMtime = 0
const changeRootMetadata = () => {
  rootMtime += 1
  grouped.set("", [
    ...directories.slice(0, -1),
    { ...directories.at(-1)!, mtime: rootMtime },
  ])
}
const fullRootRefresh = measure(() => {
  changeRootMetadata()
  if (flattenLiveFileTreeV2(groupedChildren, expandedGroup).length !== 50_000) throw Error("Full root missing rows")
}, 10)
const incrementalRootRefresh = measure(() => {
  changeRootMetadata()
  if (incrementalView.update("").length !== 50_000) throw Error("Incremental root missing rows")
}, 10)
if (incrementalView.rows().map((r) => r.node.path).join("|") !==
  flattenLiveFileTreeV2(groupedChildren, expandedGroup).map((r) => r.node.path).join("|")) {
  throw Error("Incremental root refresh diverged from authoritative flatten")
}

const getItemKey = (index: number) => paths[index]!
const options = {
  count: SIZE,
  getScrollElement: () => null,
  estimateSize: () => 22,
  getItemKey,
  scrollToFn: () => {},
  observeElementRect: () => () => {},
  observeElementOffset: () => () => {},
}
function measurementBenchmark(freshKeys: boolean) {
  const virtualizer = new Virtualizer(options)
  virtualizer.getTotalSize()
  const started = performance.now()
  for (let iteration = 0; iteration < 30; iteration++) {
    virtualizer.setOptions({ ...options, getItemKey: freshKeys ? (index: number) => paths[index]! : getItemKey })
    if (virtualizer.getTotalSize() !== SIZE * 22) throw Error("Wrong virtualizer total")
  }
  return performance.now() - started
}
const unstableResolver = describe(Array.from({ length: 3 }, () => measurementBenchmark(true)))
const stableResolver = describe(Array.from({ length: 3 }, () => measurementBenchmark(false)))

const searchToggleModel = buildFileTreeV2Model(Array.from({ length: SIZE }, (_, i) =>
  `src/group-${i % 100}/file-${i}.ts`,
))
const collapsedGroup = new Set(["src/group-51"])
const openAll = new Set<string>()
const visibleSearchView = createIncrementalSearchFileTreeRows(searchToggleModel, openAll)
const fullSearchToggle = measure(() => {
  flattenFileTreeV2(searchToggleModel, (path) => !collapsedGroup.has(path))
  flattenFileTreeV2(searchToggleModel, () => true)
})
const localSearchToggle = measure(() => {
  visibleSearchView.update(collapsedGroup)
  visibleSearchView.update(openAll)
})
if (visibleSearchView.rows().length !== searchToggleModel.total) {
  throw Error("Search collapse/expand lost visible rows")
}

// The previous implementation copied every already-discovered path on each
// paginated update. Both variants perform the same path/ancestor normalization.
const searchPages = Array.from({ length: 50 }, (_, page) =>
  Array.from({ length: 1_000 }, (_, offset) =>
    `packages/bucket-${(page + offset) % 40}/file-${page * 1_000 + offset}.ts`,
  ),
)
const formerSearchPageCopies = measure(() => {
  let result = { query: "file", matches: new Set<string>(), ancestors: new Set<string>(), rows: [] }
  for (const page of searchPages) result = mergeProjectExplorerSearchPaths(result, page)
  if (result.matches.size !== 50_000) throw Error("Incorrect cloned search results")
}, 4)
const versionedSearchPageSnapshots = measure(() => {
  const accumulator = createProjectExplorerSearchAccumulator("file")
  for (const page of searchPages) accumulator.page(page)
  if (accumulator.snapshot().matches.size !== 50_000) throw Error("Incorrect indexed search results")
}, 4)

const newPage = Array.from({ length: 1_000 }, (_, index) =>
  `src/file-new-${String(index).padStart(5, "0")}.ts`,
)
const previousSearch = buildProjectExplorerSearchTree(matches, new Set(), () => undefined, "/workspace")
const deltaElapsed: number[] = []
const fullElapsed: number[] = []
let maxDeltaSliceMs = 0
for (let run = 0; run < 4; run++) {
  const began = performance.now()
  const projected = await new Promise<FileTreeV2Model>((resolve, reject) => {
    const stop = startProjectExplorerSearchTreeDelta({
      previous: previousSearch, addedMatches: newPage, addedAncestors: [],
      root: "/workspace", lookup: () => undefined, sliceMs: 2,
      complete: (model, metrics) => {
        maxDeltaSliceMs = Math.max(maxDeltaSliceMs, metrics.maxSliceMs)
        resolve(model)
      },
    })
    if (!stop) reject(Error("Unexpected incremental fallback"))
  })
  deltaElapsed.push(performance.now() - began)
  if (projected.total !== previousSearch.total + newPage.length) throw Error("Incremental count incorrect")

  const fullStarted = performance.now()
  const rebuilt = await new Promise<FileTreeV2Model>((resolve) => startProjectExplorerSearchTree({
    matches: new Set([...matches, ...newPage]), ancestors: new Set(),
    root: "/workspace", lookup: () => undefined, sliceMs: 2, complete: resolve,
  }))
  fullElapsed.push(performance.now() - fullStarted)
  if (rebuilt.total !== projected.total ||
    flattenFileTreeV2(rebuilt, () => true).length !== flattenFileTreeV2(projected, () => true).length) {
    throw Error("Search hierarchy delta diverged from full reference")
  }
}

const remoteForRebase = Array.from({ length: 25_000 }, (_, i) => `pkg/file-${i}.ts`)
const localForRebase = Array.from({ length: 25_000 }, (_, i) => `src/file-${i}.ts`)
const localSnapshot = (paths: readonly string[]) => ({
  query: "file",
  matches: new Set(paths),
  ancestors: new Set<string>(),
  rows: [],
})
const seededAccumulator = () => {
  const accumulator = createProjectExplorerSearchAccumulator("file")
  accumulator.page(remoteForRebase)
  accumulator.local(localSnapshot(localForRebase))
  return accumulator
}
const localRemoval = localSnapshot(localForRebase.slice(1))
const synchronousRebaseDurations: number[] = []
for (let repeat = 0; repeat < 3; repeat++) {
  const accumulator = seededAccumulator()
  const started = performance.now()
  accumulator.refreshLocal(localRemoval)
  if (accumulator.snapshot().matches.size !== 49_999) throw Error("Synchronous rebase count")
  synchronousRebaseDurations.push(performance.now() - started)
}
let maximumCooperativeChunkMs = 0
const cooperativeRebaseDurations: number[] = []
for (let repeat = 0; repeat < 2; repeat++) {
  const accumulator = seededAccumulator()
  const started = performance.now()
  await new Promise<void>((resolve) => accumulator.refreshLocalCooperatively(localRemoval, {
    sliceMs: 2,
    schedule: (run) => setTimeout(() => {
      const chunkStarted = performance.now()
      run()
      maximumCooperativeChunkMs = Math.max(maximumCooperativeChunkMs, performance.now() - chunkStarted)
    }, 0),
    complete: (snapshot) => {
      if (snapshot.matches.size !== 49_999) throw Error("Cooperative rebase count")
      resolve()
    },
  }))
  cooperativeRebaseDurations.push(performance.now() - started)
}

console.info(JSON.stringify({
  corpus: SIZE,
  caveat: "isolated Bun microbenchmarks; not Electron UX measurements",
  synchronousProjection,
  cooperativeProjection: {
    totalElapsedMs: Number(cooperativeElapsedMs.toFixed(3)),
    reportedTotalMs: Number(cooperative.totalMs.toFixed(3)),
    slices: cooperative.slices,
    maxSliceMs: Number(cooperative.maxSliceMs.toFixed(3)),
  },
  liveTreeFlatten: flattenLoaded,
  singleContextLookup: { eagerFullRowIndex, directSingleRowLookup },
  watcherLocalRefresh: { full: fullLocalRefresh, incremental: incrementalLocalRefresh },
  watcherRootMetadataRefresh: { full: fullRootRefresh, incremental: incrementalRootRefresh },
  virtualizerMeasurement30Updates: { unstableResolver, stableResolver },
  searchFolderCollapseAndExpand50k: { fullReflatten: fullSearchToggle, localSplice: localSearchToggle },
  searchPagination50Pages: {
    cloneAllEarlierMatches: formerSearchPageCopies,
    versionedAppendOnlySnapshots: versionedSearchPageSnapshots,
  },
  searchHierarchyNew1000Into50000: {
    fullCooperative: describe(fullElapsed),
    incrementalCooperative: describe(deltaElapsed),
    maxIncrementalSliceMs: Number(maxDeltaSliceMs.toFixed(3)),
  },
  watcherLocalRemoval50k: {
    synchronousBlockingMs: describe(synchronousRebaseDurations),
    cooperativeElapsedMs: describe(cooperativeRebaseDurations),
    maxCooperativeChunkMs: Number(maximumCooperativeChunkMs.toFixed(3)),
    note: "Cooperative implementation trades wall time for bounded uninterrupted work",
  },
}, null, 2))
