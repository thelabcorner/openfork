import type { Matcher } from "./matcher"

// File-only @-mention search deliberately uses a scan-first engine instead of
// constructing Matcher.prepare's full trigram/prefix index on the first query.
// The full matcher is excellent once warm, but its O(N * path features) build
// cost can turn the first `@foo` into a multi-second request on 100k-file repos.
//
// This path follows the same broad shape as modern fuzzy pickers: extremely
// cheap reject/match work for every candidate, structural bonuses for basename
// and word boundaries, a bounded top-K heap, then highlight reconstruction only
// for the rows that survive. It is allocation-free in the per-path hot loop for
// ordinary ASCII repo paths.

const NEG = -1_000_000_000
const MAX_QUERY_CHARS = 64

type Ranked = {
  id: number
  score: number
  pathLength: number
}

type TokenMatch = {
  score: number
  positions?: number[]
}

type FastCorpus = {
  base: Uint32Array
  stemEnd: Uint32Array
  maskLo: Uint32Array
  maskHi: Uint32Array
}

const corpusCache = new WeakMap<object, FastCorpus>()

function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function isBoundary(path: string, index: number): boolean {
  if (index === 0) return true
  const prev = path.charCodeAt(index - 1)
  const cur = path.charCodeAt(index)
  return (
    prev === 47 || // /
    prev === 92 || // \
    prev === 95 || // _
    prev === 45 || // -
    prev === 46 || // .
    prev === 32 ||
    (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90)
  )
}

function basenameStart(path: string): number {
  const end = path.endsWith("/") || path.endsWith("\\") ? path.length - 1 : path.length
  const slash = Math.max(path.lastIndexOf("/", end - 1), path.lastIndexOf("\\", end - 1))
  return slash + 1
}

function basenameEnd(path: string): number {
  return path.endsWith("/") || path.endsWith("\\") ? path.length - 1 : path.length
}

function extensionStart(path: string, base: number, end: number): number {
  const dot = path.lastIndexOf(".", end - 1)
  return dot >= base ? dot : end
}

function maskSlot(code: number): number {
  const folded = foldAscii(code)
  if (folded >= 97 && folded <= 122) return folded - 97
  if (folded >= 48 && folded <= 57) return 32 + folded - 48
  if (folded === 47 || folded === 92) return 42
  if (folded === 95) return 43
  if (folded === 45) return 44
  if (folded === 46) return 45
  return -1
}

function prepareFastCorpus(paths: readonly Matcher.PathEntry[]): FastCorpus {
  const cached = corpusCache.get(paths as object)
  if (cached) return cached
  const base = new Uint32Array(paths.length)
  const stemEnd = new Uint32Array(paths.length)
  const maskLo = new Uint32Array(paths.length)
  const maskHi = new Uint32Array(paths.length)
  for (let id = 0; id < paths.length; id++) {
    const path = paths[id]!.path
    const b = basenameStart(path)
    const end = basenameEnd(path)
    base[id] = b
    stemEnd[id] = extensionStart(path, b, end)
    let lo = 0
    let hi = 0
    for (let i = 0; i < path.length; i++) {
      const slot = maskSlot(path.charCodeAt(i))
      if (slot < 0) continue
      if (slot < 32) lo |= 1 << slot
      else hi |= 1 << (slot - 32)
    }
    maskLo[id] = lo >>> 0
    maskHi[id] = hi >>> 0
  }
  const prepared = { base, stemEnd, maskLo, maskHi }
  corpusCache.set(paths as object, prepared)
  return prepared
}

function queryMask(tokens: readonly string[]): { lo: number; hi: number; usable: boolean } {
  let lo = 0
  let hi = 0
  for (const token of tokens) {
    for (let i = 0; i < token.length; i++) {
      const slot = maskSlot(token.charCodeAt(i))
      if (slot < 0) {
        // Spaces are token separators and need no presence bit. Other Unicode
        // characters fall back to the exact matcher rather than risking a false
        // negative from an ASCII-only prefilter.
        if (token.charCodeAt(i) !== 32) return { lo: 0, hi: 0, usable: false }
        continue
      }
      if (slot < 32) lo |= 1 << slot
      else hi |= 1 << (slot - 32)
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0, usable: true }
}

function asciiEquals(path: string, start: number, query: string): boolean {
  if (start + query.length > path.length) return false
  for (let i = 0; i < query.length; i++) {
    if (foldAscii(path.charCodeAt(start + i)) !== query.charCodeAt(i)) return false
  }
  return true
}

function acronymMatch(path: string, query: string, base: number, end: number, collect: boolean): TokenMatch | undefined {
  let qi = 0
  const positions = collect ? [] as number[] : undefined
  for (let i = base; i < end && qi < query.length; i++) {
    if (!isBoundary(path, i)) continue
    if (foldAscii(path.charCodeAt(i)) !== query.charCodeAt(qi)) continue
    positions?.push(i)
    qi++
  }
  if (qi !== query.length) return undefined
  // Acronym intent is strong but remains below an ordinary basename prefix.
  return { score: 520 + query.length * 24, positions }
}

function tokenMatch(
  path: string,
  query: string,
  base: number,
  stemEnd: number,
  collect = false,
): TokenMatch | undefined {
  if (!query || query.length > path.length) return undefined
  const end = basenameEnd(path)

  let qi = 0
  let first = -1
  let last = -1
  let consecutive = 0
  let bestConsecutive = 0
  let boundaryHits = 0
  let basenameHits = 0
  let gaps = 0
  const positions = collect ? [] as number[] : undefined

  for (let i = 0; i < path.length && qi < query.length; i++) {
    if (foldAscii(path.charCodeAt(i)) !== query.charCodeAt(qi)) continue
    if (first < 0) first = i
    if (last < 0) consecutive = 1
    else {
      const gap = i - last - 1
      gaps += gap
      consecutive = gap === 0 ? consecutive + 1 : 1
    }
    if (consecutive > bestConsecutive) bestConsecutive = consecutive
    if (isBoundary(path, i)) boundaryHits++
    if (i >= base && i < end) basenameHits++
    positions?.push(i)
    last = i
    qi++
  }

  if (qi !== query.length) {
    // Boundary acronym is the useful non-subsequence exception: e.g. `dsm`
    // should match DialogSelectModel / dialog-select-model.
    return acronymMatch(path, query, base, end, collect)
  }

  let score =
    bestConsecutive * 18 +
    boundaryHits * 16 +
    basenameHits * 12 -
    Math.min(gaps, 80) -
    Math.min(base >> 2, 30)

  if (first >= base) score += 120
  if (first === base) score += 90

  const prefix = asciiEquals(path, base, query)
  if (prefix) {
    score += 520
    const stemLength = stemEnd - base
    if (stemLength === query.length) score += 320
    else score += Math.max(0, 80 - (stemLength - query.length) * 4)
  } else if (basenameHits === query.length) {
    score += 180
  }

  return { score, positions }
}

function pathPrefixMatch(path: string, query: string): TokenMatch | undefined {
  // Directory-completion intent is path-shaped rather than basename-shaped.
  // Require an ordered path prefix (case-insensitive ASCII) and rank shorter
  // completions ahead of deeper ones.
  const normalized = query.replaceAll("\\", "/")
  const target = path.replaceAll("\\", "/")
  if (normalized.length > target.length) return undefined
  for (let i = 0; i < normalized.length; i++) {
    if (foldAscii(target.charCodeAt(i)) !== foldAscii(normalized.charCodeAt(i))) return undefined
  }
  return {
    score: 2_000 - Math.min(1_000, target.length - normalized.length),
    positions: Array.from({ length: normalized.length }, (_, i) => i),
  }
}

function scorePath(path: string, tokens: readonly string[], directoryMode: boolean, base: number, stemEnd: number): number {
  if (directoryMode) return pathPrefixMatch(path, tokens[0] ?? "")?.score ?? NEG
  let total = 0
  for (const token of tokens) {
    const match = tokenMatch(path, token, base, stemEnd)
    if (!match) return NEG
    total += match.score
  }
  // Multiple terms that all land in one path are strong intent. Keep this
  // modest so exact/prefix basename structure remains the dominant signal.
  if (tokens.length > 1) total += (tokens.length - 1) * 32
  return total
}

function positionsFor(
  path: string,
  tokens: readonly string[],
  directoryMode: boolean,
  base: number,
  stemEnd: number,
): number[] | undefined {
  if (directoryMode) return pathPrefixMatch(path, tokens[0] ?? "")?.positions
  const positions: number[] = []
  for (const token of tokens) {
    const match = tokenMatch(path, token, base, stemEnd, true)
    if (!match?.positions) continue
    positions.push(...match.positions)
  }
  if (positions.length === 0) return undefined
  positions.sort((a, b) => a - b)
  let write = 1
  for (let read = 1; read < positions.length; read++) {
    if (positions[read] !== positions[write - 1]) positions[write++] = positions[read]!
  }
  positions.length = write
  return positions
}

function worse(a: Ranked, b: Ranked): boolean {
  if (a.score !== b.score) return a.score < b.score
  if (a.pathLength !== b.pathLength) return a.pathLength > b.pathLength
  return a.id > b.id
}

function swap(heap: Ranked[], a: number, b: number) {
  const value = heap[a]!
  heap[a] = heap[b]!
  heap[b] = value
}

function siftUp(heap: Ranked[], start: number) {
  let index = start
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!worse(heap[index]!, heap[parent]!)) break
    swap(heap, index, parent)
    index = parent
  }
}

function siftDown(heap: Ranked[], start: number) {
  let index = start
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    let worst = index
    if (left < heap.length && worse(heap[left]!, heap[worst]!)) worst = left
    if (right < heap.length && worse(heap[right]!, heap[worst]!)) worst = right
    if (worst === index) return
    swap(heap, index, worst)
    index = worst
  }
}

function betterThan(a: Ranked, b: Ranked): boolean {
  return worse(b, a)
}

export function searchFileMentionsFast(
  paths: readonly Matcher.PathEntry[],
  input: { query: string; limit: number; offset: number },
): Matcher.QueryPage {
  const raw = input.query.trim().slice(0, MAX_QUERY_CHARS)
  if (!raw) return { files: [], symbols: [], results: [], hasMore: false, total: 0 }

  const directoryMode = /[\\/]$/.test(raw)
  const tokens = directoryMode
    ? [raw.toLowerCase().replaceAll("\\", "/")]
    : raw
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
  if (tokens.length === 0) return { files: [], symbols: [], results: [], hasMore: false, total: 0 }

  const offset = Math.max(0, input.offset)
  const limit = Math.max(1, input.limit)
  const capacity = Math.max(1, offset + limit)
  const heap: Ranked[] = []
  let total = 0
  const corpus = prepareFastCorpus(paths)
  const required = queryMask(tokens)

  for (let id = 0; id < paths.length; id++) {
    const row = paths[id]!
    if (directoryMode && !row.isDir) continue
    if (
      required.usable &&
      (((corpus.maskLo[id]! & required.lo) >>> 0) !== required.lo ||
        ((corpus.maskHi[id]! & required.hi) >>> 0) !== required.hi)
    ) continue
    const score = scorePath(row.path, tokens, directoryMode, corpus.base[id]!, corpus.stemEnd[id]!)
    if (score <= NEG) continue
    total++
    const ranked = { id, score, pathLength: row.path.length }
    if (heap.length < capacity) {
      heap.push(ranked)
      siftUp(heap, heap.length - 1)
      continue
    }
    if (!betterThan(ranked, heap[0]!)) continue
    heap[0] = ranked
    siftDown(heap, 0)
  }

  heap.sort((a, b) => b.score - a.score || a.pathLength - b.pathLength || a.id - b.id)
  const page = heap.slice(offset, offset + limit)
  const files: Matcher.MatchResult<Matcher.PathEntry>[] = []
  const results: Matcher.UnifiedResult[] = []
  for (const ranked of page) {
    const row = paths[ranked.id]!
    const baseOffset = corpus.base[ranked.id]!
    const positions = positionsFor(row.path, tokens, directoryMode, baseOffset, corpus.stemEnd[ranked.id]!)
    files.push({ item: row, score: ranked.score, positions, baseOffset })
    results.push({
      kind: "file",
      path: row.path,
      type: row.isDir ? "directory" : "file",
      score: ranked.score,
      positions,
      baseOffset,
      size: row.size,
      mtime: row.mtime,
      lineCount: row.lineCount,
    })
  }

  return {
    files,
    symbols: [],
    results,
    hasMore: offset + results.length < total,
    total,
  }
}
