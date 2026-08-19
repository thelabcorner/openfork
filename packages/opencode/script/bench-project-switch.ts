/**
 * perf-bench: project-switch latency BEFORE baseline.
 *
 * Measures the four cost centers of switching A -> large project B in the
 * explorer, BEFORE the persisted-index / serialization / client-cache work:
 *
 *   A. Wire encode/decode of the full tree as JSON (the current LegacyEntry
 *      wire shape). Synthetic ~50-100k node tree generated on the fly
 *      (deterministic, never checked in).
 *   B. Real filesystem walk: recursive FileSystem.list per directory (the
 *      per-directory readdir+stat+sort+ignore cost the persisted index
 *      eliminates). Runs against a real project dir (default: cwd).
 *   C. file.list("") root round-trip: single root listing latency (first
 *      paint on switch).
 *   D. Client tree-build: building a nested tree from a flat entry list.
 *
 * Run:  bun run script/bench-project-switch.ts
 * Env:  BENCH_NODES (default 50000), BENCH_DIR (default cwd),
 *       BENCH_ITERS (default 5), BENCH_BRANCH (default 7),
 *       BENCH_FILES_PER_DIR (default 3), BENCH_DEPTH (default 5)
 *
 * Output is a stable, machine-parseable block (BENCH_BEGIN ... BENCH_END)
 * plus human-readable lines. Median-of-N is reported for stability.
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeLocationNode, makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { IndexSerialization } from "@opencode-ai/core/filesystem/index-serialization"
import { FileIndex } from "@opencode-ai/core/filesystem/index"
import { Global } from "@opencode-ai/core/global"
import { readdirSync, type Dirent } from "node:fs"
import os from "node:os"
import path from "node:path"

const NODES = Number(process.env.BENCH_NODES ?? 50_000)
const ITERS = Number(process.env.BENCH_ITERS ?? 5)
const BRANCH = Number(process.env.BENCH_BRANCH ?? 7)
const FILES_PER_DIR = Number(process.env.BENCH_FILES_PER_DIR ?? 3)
const DEPTH = Number(process.env.BENCH_DEPTH ?? 5)
const BENCH_DIR = process.env.BENCH_DIR ?? process.cwd()

// ---------------------------------------------------------------------------
// Synthetic tree generation (deterministic, on the fly)
// ---------------------------------------------------------------------------

interface SynNode {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

/** Deterministic PRNG so runs are reproducible across machines. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a deterministic tree: each dir has `branch` subdirs down to `depth`,
 * plus `filesPerDir` files. Returns the flat LegacyEntry-shaped array.
 */
function buildSyntheticTree(): SynNode[] {
  const rand = mulberry32(0x5eed)
  const entries: SynNode[] = []
  const root = BENCH_DIR.replace(/[\\/]/g, "/")
  const walk = (rel: string, depth: number) => {
    const dirPath = rel === "" ? "" : rel + "/"
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const name = `file_${f}_${Math.floor(rand() * 1e6)}.ts`
      const p = dirPath + name
      entries.push({ name, path: p, absolute: `${root}/${p}`, type: "file", ignored: false })
    }
    if (depth <= 0) return
    for (let b = 0; b < BRANCH; b++) {
      const name = `dir_${b}`
      const p = dirPath + name
      entries.push({ name, path: p, absolute: `${root}/${p}`, type: "directory", ignored: false })
      walk(p, depth - 1)
    }
  }
  walk("", DEPTH)
  return entries
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function bench(label: string, fn: () => void): number {
  // warmup
  fn()
  const samples: number[] = []
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  const m = median(samples)
  console.log(`  ${label}: ${m.toFixed(2)}ms  (n=${ITERS}, median, min=${Math.min(...samples).toFixed(2)}, max=${Math.max(...samples).toFixed(2)})`)
  return m
}

// ---------------------------------------------------------------------------
// A. Wire encode/decode (JSON = BEFORE format)
// ---------------------------------------------------------------------------

function benchWire(entries: SynNode[]) {
  console.log(`\n[A] Wire encode/decode (JSON LegacyEntry array, ${entries.length.toLocaleString()} nodes)`)
  let blob = ""
  const encodeMs = bench("JSON.stringify (encode)", () => {
    blob = JSON.stringify(entries)
  })
  let decoded: SynNode[] = []
  const decodeMs = bench("JSON.parse (decode)", () => {
    decoded = JSON.parse(blob)
  })
  const bytes = Buffer.byteLength(blob, "utf8")
  console.log(`  blob size: ${(bytes / 1024).toFixed(1)} KiB (${(bytes / 1024 / 1024).toFixed(2)} MiB)`)
  console.log(`  round-trip: ${(encodeMs + decodeMs).toFixed(2)}ms`)
  if (decoded.length !== entries.length) throw new Error("decode length mismatch")
  return { encodeMs, decodeMs, bytes }
}

// ---------------------------------------------------------------------------
// B. Real filesystem walk via FileSystem.list (per-directory cost)
// ---------------------------------------------------------------------------

// Minimal runtime: FileSystem.list only needs FSUtil + Location. We provide
// Location directly and stub FileSystemSearch (list never calls it), so we
// avoid pulling in EventV2 -> Database (which may be corrupt/unavailable).
const benchDir = AbsolutePath.make(BENCH_DIR)
const boundLocation = makeLocationNode({
  service: Location.Service,
  layer: Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: benchDir,
      workspaceID: undefined,
      project: { id: "bench" as never, directory: benchDir },
    }),
  ),
  deps: [],
})
const stubSearch = makeLocationNode({
  service: FileSystemSearch.Service,
  layer: Layer.succeed(
    FileSystemSearch.Service,
    FileSystemSearch.Service.of({
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
    }),
  ),
  deps: [],
})
const benchLayer = LayerNode.compile(FileSystem.node, [
  [Location.node, boundLocation],
  [FileSystemSearch.node, stubSearch],
])
const benchRt = ManagedRuntime.make(benchLayer)

const run = <A, R>(effect: Effect.Effect<A, unknown, R>) => benchRt.runPromise(effect as never) as Promise<A>

/** Enumerate all directories under root (non-recursive readdir walk). */
function collectDirs(root: string): string[] {
  const dirs: string[] = []
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()!
    dirs.push(cur)
    let children: Dirent[] = []
    try {
      children = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const c of children) {
      if (c.isDirectory()) stack.push(path.join(cur, c.name))
    }
  }
  return dirs
}

async function benchRealWalk() {
  console.log(`\n[B] Real filesystem walk via FileSystem.list (dir=${BENCH_DIR})`)
  const dirs = collectDirs(BENCH_DIR)
  console.log(`  directories to list: ${dirs.length.toLocaleString()}`)

  // warmup: one list call to prime the runtime
  await run(FileSystem.Service.use((svc) => svc.list()))

  const samples: number[] = []
  let totalNodes = 0
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now()
    let nodes = 0
    for (const d of dirs) {
      const rel = path.relative(BENCH_DIR, d).replace(/\\/g, "/")
      const entries = await run(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(rel) })))
      nodes += entries.length
    }
    samples.push(performance.now() - t0)
    totalNodes = nodes
  }
  const m = median(samples)
  console.log(`  full walk (${dirs.length} dirs, ${totalNodes.toLocaleString()} entries): ${m.toFixed(2)}ms  (n=${ITERS}, median)`)
  console.log(`  per-directory avg: ${(m / dirs.length).toFixed(3)}ms`)
  return { walkMs: m, dirs: dirs.length, nodes: totalNodes }
}

// ---------------------------------------------------------------------------
// C. file.list("") root round-trip
// ---------------------------------------------------------------------------

async function benchRootList() {
  console.log(`\n[C] file.list("") root round-trip (dir=${BENCH_DIR})`)
  await run(FileSystem.Service.use((svc) => svc.list()))
  const samples: number[] = []
  let count = 0
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now()
    const entries = await run(FileSystem.Service.use((svc) => svc.list()))
    samples.push(performance.now() - t0)
    count = entries.length
  }
  const m = median(samples)
  console.log(`  root list (${count} entries): ${m.toFixed(2)}ms  (n=${ITERS}, median)`)
  return { rootMs: m, count }
}

// ---------------------------------------------------------------------------
// D. Client tree-build from flat entries
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string
  path: string
  type: "file" | "directory"
  children?: TreeNode[]
}

/** Build a nested tree from a flat (path, type) list — models client reconcile. */
function buildTree(entries: SynNode[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] }
  const map = new Map<string, TreeNode>([[root.path, root]])
  for (const e of entries) {
    const parts = e.path.split("/")
    const node: TreeNode = { name: parts[parts.length - 1], path: e.path, type: e.type, children: e.type === "directory" ? [] : undefined }
    map.set(e.path, node)
    const parentPath = parts.slice(0, -1).join("/")
    const parent = map.get(parentPath) ?? root
    parent.children!.push(node)
  }
  return root
}

function benchClientTree(entries: SynNode[]) {
  console.log(`\n[D] Client tree-build from flat entries (${entries.length.toLocaleString()} nodes)`)
  let tree: TreeNode | null = null
  const ms = bench("buildTree", () => {
    tree = buildTree(entries)
  })
  const dirs = countDirs(tree!)
  console.log(`  tree: ${dirs} directories`)
  return { treeMs: ms }
}

function countDirs(node: TreeNode): number {
  if (node.type !== "directory") return 0
  return 1 + (node.children ?? []).reduce((acc, c) => acc + countDirs(c), 0)
}

// ---------------------------------------------------------------------------
// E. In-memory footprint of the built tree (for LRU cache budget)
// ---------------------------------------------------------------------------

function benchMemory(entries: SynNode[]) {
  console.log(`\n[E] In-memory footprint of built tree (${entries.length.toLocaleString()} nodes)`)
  // warm up + let the tree settle
  buildTree(entries)
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  const before = process.memoryUsage().heapUsed
  const tree = buildTree(entries)
  const after = process.memoryUsage().heapUsed
  const bytes = Math.max(0, after - before)
  console.log(`  heap delta: ${(bytes / 1024 / 1024).toFixed(2)} MiB (${(bytes / entries.length).toFixed(0)} B/node)`)
  return { heapBytes: bytes, bytesPerNode: bytes / entries.length }
}

// ---------------------------------------------------------------------------
// F. Persisted-index codec (IndexSerialization) vs JSON baseline
// ---------------------------------------------------------------------------

/** Convert flat LegacyEntry list into the index blob's per-directory subtrees. */
function toIndexBlob(entries: SynNode[]): IndexSerialization.IndexBlobInput {
  const buckets = new Map<string, IndexSerialization.IndexEntry[]>()
  for (const e of entries) {
    const parts = e.path.split("/")
    const parent = parts.slice(0, -1).join("/")
    const arr = buckets.get(parent) ?? []
    arr.push({ path: RelativePath.make(e.path), type: e.type })
    buckets.set(parent, arr)
  }
  const subtrees: Record<string, IndexSerialization.IndexSubtree> = {}
  for (const [dir, arr] of buckets) subtrees[dir] = { at: 0, entries: arr }
  return {
    schemaVersion: 1,
    builtAt: Date.now(),
    root: BENCH_DIR.replace(/[\\/]/g, "/"),
    rootStat: { mtimeMs: 0, size: 0, ino: 0 },
    subtrees,
  }
}

async function benchIndexCodec(entries: SynNode[]) {
  console.log(`\n[F] Persisted-index codec (IndexSerialization, ${entries.length.toLocaleString()} nodes)`)
  const blob = toIndexBlob(entries)
  const subtreeCount = Object.keys(blob.subtrees).length
  console.log(`  subtrees: ${subtreeCount.toLocaleString()}`)

  let bytes: Uint8Array = new Uint8Array()
  const encodeMs = bench("encode (canonical JSON + sha256)", () => {
    bytes = IndexSerialization.encode(blob)
  })
  let decoded: IndexSerialization.IndexBlob | null = null
  const decodeMs = bench("decode (parse + schema + checksum)", () => {
    decoded = benchRt.runSync(IndexSerialization.decode(bytes))
  })
  const size = bytes.byteLength
  console.log(`  blob size: ${(size / 1024).toFixed(1)} KiB (${(size / 1024 / 1024).toFixed(2)} MiB)`)
  console.log(`  round-trip: ${(encodeMs + decodeMs).toFixed(2)}ms`)
  if (!decoded) throw new Error("index codec round-trip mismatch")
  return { encodeMs, decodeMs, bytes: size, subtrees: subtreeCount }
}

// ---------------------------------------------------------------------------
// G. FileIndex service: cold build vs warm list (the switch hot path)
// ---------------------------------------------------------------------------

const tempData = path.join(os.tmpdir(), `bench-file-index-${Date.now()}`)
const boundGlobal = makeGlobalNode({
  service: Global.Service,
  layer: Layer.succeed(Global.Service, Global.Service.of(Global.make({ data: tempData }))),
  deps: [],
})
const fileIndexLayer = LayerNode.compile(FileIndex.node, [
  [Location.node, boundLocation],
  [FileSystemSearch.node, stubSearch],
  [Global.node, boundGlobal],
])
const fileIndexRt = ManagedRuntime.make(fileIndexLayer)
const runIndex = <A>(effect: Effect.Effect<A, unknown, never>) => fileIndexRt.runPromise(effect as never) as Promise<A>

async function benchFileIndex() {
  console.log(`\n[G] FileIndex service (dir=${BENCH_DIR})`)
  const root = RelativePath.make("")

  // cold: first list builds the whole index (walks the tree)
  const t0 = performance.now()
  await runIndex(FileIndex.Service.use((svc) => svc.list(root)))
  const coldMs = performance.now() - t0
  console.log(`  cold list("") [full build]: ${coldMs.toFixed(2)}ms`)

  // warm: subsequent lists are map lookups (the per-switch hot path)
  const samples: number[] = []
  for (let i = 0; i < ITERS; i++) {
    const t = performance.now()
    await runIndex(FileIndex.Service.use((svc) => svc.list(root)))
    samples.push(performance.now() - t)
  }
  const warmMs = median(samples)
  console.log(`  warm list("") [map lookup]: ${warmMs.toFixed(3)}ms  (n=${ITERS}, median)`)

  // warm list of a deep subdirectory (children-of-dir on switch)
  const deep = RelativePath.make("src")
  const deepSamples: number[] = []
  for (let i = 0; i < ITERS; i++) {
    const t = performance.now()
    await runIndex(FileIndex.Service.use((svc) => svc.list(deep)))
    deepSamples.push(performance.now() - t)
  }
  const deepMs = median(deepSamples)
  console.log(`  warm list("src") [map lookup]: ${deepMs.toFixed(3)}ms  (n=${ITERS}, median)`)
  return { coldMs, warmMs, deepMs }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const bunVersion = (process.versions as { bun?: string }).bun ?? "n/a"

async function main() {
  console.log("=== perf-bench: project-switch latency BEFORE baseline ===")
  console.log(`machine: ${process.platform} ${process.arch} | node ${process.version} | bun ${bunVersion}`)
  console.log(`config: nodes=${NODES} iters=${ITERS} branch=${BRANCH} filesPerDir=${FILES_PER_DIR} depth=${DEPTH} dir=${BENCH_DIR}`)
  console.log(`ts: ${new Date().toISOString()}`)

  const entries = buildSyntheticTree()
  console.log(`synthetic tree: ${entries.length.toLocaleString()} nodes (target ~${NODES.toLocaleString()})`)

  const wire = benchWire(entries)
  const walk = await benchRealWalk()
  const root = await benchRootList()
  const client = benchClientTree(entries)
  const memory = benchMemory(entries)
  const index = await benchIndexCodec(entries)
  const fileIndex = await benchFileIndex()

  console.log("\n=== BENCH_BEGIN ===")
  console.log(JSON.stringify(
    {
      benchmark: "project-switch-before",
      machine: { platform: process.platform, arch: process.arch, node: process.version, bun: bunVersion },
      config: { nodes: NODES, iters: ITERS, branch: BRANCH, filesPerDir: FILES_PER_DIR, depth: DEPTH, dir: BENCH_DIR },
      syntheticNodes: entries.length,
      wire: { encodeMs: wire.encodeMs, decodeMs: wire.decodeMs, roundTripMs: wire.encodeMs + wire.decodeMs, bytes: wire.bytes },
      realWalk: { walkMs: walk.walkMs, dirs: walk.dirs, nodes: walk.nodes, perDirMs: walk.walkMs / walk.dirs },
      rootList: { rootMs: root.rootMs, count: root.count },
      clientTree: { treeMs: client.treeMs },
      memory: { heapBytes: memory.heapBytes, bytesPerNode: memory.bytesPerNode },
      indexCodec: { encodeMs: index.encodeMs, decodeMs: index.decodeMs, roundTripMs: index.encodeMs + index.decodeMs, bytes: index.bytes, subtrees: index.subtrees },
      fileIndex: { coldMs: fileIndex.coldMs, warmMs: fileIndex.warmMs, deepMs: fileIndex.deepMs },
    },
    null,
    2,
  ))
  console.log("=== BENCH_END ===")
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
