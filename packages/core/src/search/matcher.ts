export * as Matcher from "./matcher"

// Fuzzy mention matcher: IR-style two-phase engine per docs/matching-research.
// Phase A (matcher-index) generates a bounded candidate frontier from prefix/
// boundary/acronym champions, rare-trigram intersections, previous-frontier
// filter-down, and char-presence bitsets. Phase B (matcher-score) precisely
// scores only that frontier with an fzf-v2-inspired greedy+backtrack DP.
// Rank hysteresis stabilizes visible rows across keystrokes; typo mode runs
// only on strict underfill.

import {
  buildIndex,
  lookupAcroGram,
  lookupGram,
  lookupPrefix,
  type IndexDoc,
  type SearchIndex,
} from "./matcher-index"
import { MatcherScore, NEG, matchedPositions } from "./matcher-score"

// ---- public contract -------------------------------------------------------
export interface PathEntry {
  path: string
  isDir: boolean
}
export interface SymbolEntry {
  name: string
  kind: string
  path: string
  line: number
}

// positions are ascending indices into the candidate's full text (relative path
// for files/dirs, symbol name for symbols). baseOffset = index where the
// display basename starts, so clients can project to basename coordinates.
export interface MatchResult<T> {
  item: T
  score: number
  positions?: number[]
  baseOffset?: number
}

export interface QueryOptions {
  limit?: number
  offset?: number
  symbols?: boolean
}

export interface UnifiedResult {
  kind: "file" | "symbol"
  path?: string
  type?: "file" | "directory"
  name?: string
  symbolKind?: string
  line?: number
  score: number
  positions?: number[]
  baseOffset?: number
}

export interface QueryPage {
  files: MatchResult<PathEntry>[]
  symbols: MatchResult<SymbolEntry>[]
  results: UnifiedResult[]
  hasMore: boolean
  total: number
}

export interface StageTimings {
  generateUs: number
  scoreUs: number
  heapUs: number
  materializeUs: number
  frontier: number
  scored: number
}

export interface QuerySession {
  query(q: string, opts?: QueryOptions): QueryPage
  readonly lastTimings: StageTimings | undefined
}

export interface Prepared {
  readonly paths: Corpus<PathEntry>
  readonly symbols: Corpus<SymbolEntry>
}

export interface Corpus<T> {
  readonly index: SearchIndex
  readonly rows: readonly T[]
}

const FRONTIER_MAX = 1024
const SCORE_TARGET = 512
const MAX_POOL = 10_000
const QUERY_MAX = 32
const STICKY_BONUS = 8
const BUCKET_SHIFT = 2
const TYPO_PENALTY = 24

// ---- prepare ----------------------------------------------------------------
function pathDocs(paths: readonly PathEntry[]): IndexDoc[] {
  return paths.map((p) => {
    const lowerTrail = p.path.endsWith("/") ? p.path.length - 1 : p.path.length
    const slash = p.path.lastIndexOf("/", lowerTrail - 1)
    return {
      text: p.path,
      // strip one trailing '/' so a directory's LAST SEGMENT is its primary
      // field (folder basenames compete with file basenames)
      primaryStart: slash < 0 ? 0 : slash + 1,
      isDir: p.isDir,
      extRank: extRankOf(p.path, slash < 0 ? 0 : slash + 1),
    }
  })
}

function symbolDocs(symbols: readonly SymbolEntry[]): IndexDoc[] {
  return symbols.map((s) => ({
    text: s.name,
    primaryStart: 0,
    isDir: false,
    extRank: 99,
  }))
}

function extRankOf(path: string, baseStart: number): number {
  const dot = path.lastIndexOf(".")
  if (dot < baseStart || dot === path.length - 1) return 99
  switch (path.slice(dot + 1).toLowerCase()) {
    case "ts":
    case "tsx":
    case "mdx":
      return 0
    case "md":
      return 1
    case "js":
    case "jsx":
      return 2
    case "json":
      return 3
    case "css":
      return 4
    case "html":
      return 5
    default:
      return 99
  }
}

export function prepare(candidates: { paths: readonly PathEntry[]; symbols: readonly SymbolEntry[] }): Prepared {
  return {
    paths: { index: buildIndex(pathDocs(candidates.paths)), rows: candidates.paths },
    symbols: { index: buildIndex(symbolDocs(candidates.symbols)), rows: candidates.symbols },
  }
}

// ---- query scratch ----------------------------------------------------------
interface Scratch {
  frontier: Uint32Array
  frontierCount: number
  cursors: Uint16Array
  seenEpoch: Int32Array
  epoch: number
  countedEpoch: Int32Array
  queryId: number
  prevFrontier: Uint32Array
  prevCursors: Uint16Array
  prevCount: number
  prevStateValid: boolean
  prevQLen: number
  prevQ: Uint16Array
  heapIds: Uint32Array
  heapScores: Int32Array
  heapSize: number
  heapCap: number
  visIds: Uint32Array
  visOrder: Int32Array
  visCount: number
  timings: StageTimings
}

function makeScratch(count: number): Scratch {
  const frontierCap = Math.min(Math.max(FRONTIER_MAX, 64), Math.max(count, 1))
  return {
    frontier: new Uint32Array(frontierCap),
    frontierCount: 0,
    cursors: new Uint16Array(frontierCap),
    seenEpoch: new Int32Array(count),
    epoch: 0,
    countedEpoch: new Int32Array(count),
    queryId: 0,
    prevFrontier: new Uint32Array(frontierCap),
    prevCursors: new Uint16Array(frontierCap),
    prevCount: 0,
    prevStateValid: false,
    prevQLen: 0,
    prevQ: new Uint16Array(QUERY_MAX),
    heapIds: new Uint32Array(1024),
    heapScores: new Int32Array(1024),
    heapSize: 0,
    heapCap: 30,
    visIds: new Uint32Array(128),
    visOrder: new Int32Array(128),
    visCount: 0,
    timings: { generateUs: 0, scoreUs: 0, heapUs: 0, materializeUs: 0, frontier: 0, scored: 0 },
  }
}

// ---- query folding -----------------------------------------------------------
function foldQuery(q: string, out: Uint16Array): number {
  let n = 0
  for (let i = 0; i < q.length && n < QUERY_MAX; i++) {
    let c = q.charCodeAt(i)
    if (c >= 65 && c <= 90) c += 32
    out[n++] = c
  }
  return n
}

function isBoundaryUnit(prev: number, c: number): boolean {
  if (prev === 47 || prev === 95 || prev === 45 || prev === 46 || prev === 32) return true
  return prev >= 97 && prev <= 122 && c >= 65 && c <= 90
}

// ---- session ------------------------------------------------------------------
class Session implements QuerySession {
  lastTimings: StageTimings | undefined
  constructor(
    private prepared: Prepared,
    private ps: Scratch,
    private ss: Scratch,
  ) {}

  query(q: string, opts: QueryOptions = {}): QueryPage {
    const offset = Math.max(0, opts.offset ?? 0)
    const limit = Math.max(1, Math.min(opts.limit ?? 30, MAX_POOL))
    const wantSymbols = opts.symbols !== false
    const trimmed = q.trim()
    // fetch FULL pools [0, offset+limit) from each corpus — merge() applies
    // the global window after interleaving, so pages are stable slices of one
    // canonical ranking
    const pool = Math.min(offset + limit, MAX_POOL)
    const fp = runCorpusQuery(this.prepared.paths, this.ps, trimmed, 0, pool)
    const sp = wantSymbols ? runCorpusQuery(this.prepared.symbols, this.ss, trimmed, 0, pool) : emptyPage<SymbolEntry>()
    this.lastTimings = this.ps.timings
    return merge(fp, sp, this.prepared, offset, limit)
  }
}

function emptyPage<T>(): CorpusPage<T> {
  return { ids: [], scores: [], positions: [], total: 0, baseOffsets: [] }
}

interface CorpusPage<T> {
  ids: number[]
  scores: number[]
  positions: Array<number[] | undefined>
  baseOffsets: number[]
  total: number
  _rows?: readonly T[]
}

export function createSession(prepared: Prepared): QuerySession {
  return new Session(
    prepared,
    makeScratch(prepared.paths.index.count),
    makeScratch(prepared.symbols.index.count),
  )
}

// ---- shared candidate scoring -------------------------------------------------
// One scoring path for the pipeline, the exhaustive oracle, and the full-scan
// competitor, so rankings are directly comparable. Final score = sum of token
// match scores + static prior + primary exact/prefix bonus (single-token)
// − depth penalty (doc §4.1: deep vendor paths lose near-ties to project files).
export function scoreCandidateIndex(
  idx: SearchIndex,
  id: number,
  tokens: Uint16Array[],
): number {
  const from = idx.textOff[id]!
  const len = idx.textLen[id]!
  const primaryStart = idx.primaryOff[id]!
  let sum = 0
  for (const q of tokens) {
    const r = MatcherScore.matchToken(idx.normPool, idx.bonusPool, from, from, len, q, primaryStart)
    if (r.score <= NEG) return NEG
    sum += r.score
  }
  if (tokens.length === 1) {
    sum += MatcherScore.primaryPrefixBonus(
      idx.normPool,
      primaryStart,
      len - (primaryStart - from),
      tokens[0]!,
    )
  }
  sum += idx.staticPrior[id]!
  return sum - Math.min(idx.depth[id]! * 2, 30)
}

function foldTokens(q: string): Uint16Array[] {
  const tokens: Uint16Array[] = []
  const folded: number[] = []
  for (let i = 0; i <= q.length; i++) {
    const c = i < q.length ? foldLowerCode(q.charCodeAt(i)) : 32
    if (c !== 32 && folded.length < QUERY_MAX) folded.push(c)
    else if (c === 32 && folded.length > 0) {
      const buf = new Uint16Array(folded.length)
      buf.set(folded)
      tokens.push(buf)
      folded.length = 0
    }
  }
  return tokens
}

// ---- corpus query pipeline ----------------------------------------------------
function runCorpusQuery<T extends PathEntry | SymbolEntry>(
  corpus: Corpus<T>,
  s: Scratch,
  q: string,
  offset: number,
  limit: number,
): CorpusPage<T> {
  const tGen0 = performance.now()
  const idx = corpus.index
  const capacity = Math.min(offset + limit, MAX_POOL)

  // directory-completion mode: trailing '/' → prefix scan over directories
  if (q.endsWith("/")) return dirPrefixPage(corpus, s, q.toLowerCase(), offset, limit)

  const tokens: Uint16Array[] = []
  const tokLens: number[] = []
  {
    const folded: number[] = []
    for (let i = 0; i <= q.length; i++) {
      const c = i < q.length ? foldLowerCode(q.charCodeAt(i)) : 32
      if (c !== 32 && folded.length < QUERY_MAX) folded.push(c)
      else if (c === 32 && folded.length > 0) {
        const buf = new Uint16Array(folded.length)
        buf.set(folded)
        tokens.push(buf)
        tokLens.push(folded.length)
        folded.length = 0
      }
    }
  }
  if (tokens.length === 0) return emptyPage()
  let tokLensSum = 0
  for (const l of tokLens) tokLensSum += l

  s.epoch++
  s.frontierCount = 0
  s.heapSize = 0
  s.heapCap = Math.min(capacity, s.heapScores.length)

  // pick the rarest token as the generation driver (AND-verify the rest)
  let driver = 0
  if (tokens.length > 1) {
    let bestCost = Number.POSITIVE_INFINITY
    for (let ti = 0; ti < tokens.length; ti++) {
      const cost = estimateTokenCost(idx, tokens[ti]!, tokLens[ti]!)
      if (cost < bestCost) {
        bestCost = cost
        driver = ti
      }
    }
  }

  const dq = tokens[driver]!
  const dlen = tokLens[driver]!

  // channel 1: previous-frontier filter-down (single-token appends only)
  if (
    tokens.length === 1 &&
    s.prevStateValid &&
    dlen === s.prevQLen + 1 &&
    dlen <= QUERY_MAX &&
    prefixOf(s.prevQ, s.prevQLen, dq, dlen)
  ) {
    const c = dq[dlen - 1]!
    let out = 0
    for (let i = 0; i < s.prevCount; i++) {
      const id = s.prevFrontier[i]!
      if (out >= s.frontier.length) break
      const from = idx.textOff[id]!
      const len = idx.textLen[id]!
      const hit = findCharAfter(idx.normPool, c, from + Math.min(s.prevCursors[i]!, len - 1) + 1, from + len)
      if (hit < 0) continue
      s.frontier[out] = id
      s.cursors[out] = hit - from
      out++
    }
    s.frontierCount = out
  }

  // channel 2: prefix/boundary/acronym champions
  addChampions(idx, s, dq, dlen)
  // channel 3: rare trigram intersections (q>=3)
  if (dlen >= 3 && s.frontierCount < s.frontier.length) addRareGrams(idx, s, dq, dlen)

  const tGen1 = performance.now()

  // score the WHOLE frontier through the shared scoring path (score-only;
  // highlight positions are reconstructed for the final K afterwards).
  // No truncation: candidates that cannot beat the heap worst are skipped by
  // a cheap static bound instead.
  const scoreCount = s.frontierCount
  const tScore0 = performance.now()
  s.queryId++
  const qid = s.queryId
  let total = 0
  for (let fi = 0; fi < scoreCount; fi++) {
    const id = s.frontier[fi]!
    if (s.heapSize >= s.heapCap) {
      const bound = idx.staticPrior[id]! + (tokLensSum + 1) * 36 + MatcherScore.PRIMARY_EXACT_BONUS + 20
      if (bound <= s.heapScores[0]!) continue
    }
    const sum = scoreCandidateIndex(idx, id, tokens)
    if (sum <= NEG) continue
    if (s.countedEpoch[id] !== qid) {
      s.countedEpoch[id] = qid
      total++
    }
    heapOffer(s, id, sum)
  }

  // channel 4 (underfill): char-presence superset sweep. Every subsequence
  // match contains every query character, so the AND of per-char presence
  // bitmaps is a COMPLETE candidate superset — iterate it all, O(1)-skip
  // hopeless entries, and validate survivors precisely. This replaces any
  // full-corpus scan.
  if (total < capacity) {
    total += bitsetSupersetSweep(idx, s, tokens, tokLensSum, qid)
  }
  const tScore1 = performance.now()

  // typo mode: adjacent transposition of the driver token, strict underfill only
  if (total < limit && dlen >= 4 && tokens.length === 1) {
    for (let i = 0; i + 1 < dlen && total < limit; i++) {
      const savedA = dq[i]!
      const savedB = dq[i + 1]!
      dq[i] = savedB
      dq[i + 1] = savedA
      s.epoch++
      s.frontierCount = 0
      addChampions(idx, s, dq, dlen)
      if (dlen >= 3) addRareGrams(idx, s, dq, dlen)
      for (let fi = 0; fi < Math.min(s.frontierCount, SCORE_TARGET); fi++) {
        const id = s.frontier[fi]!
        const from = idx.textOff[id]!
        const r = MatcherScore.matchToken(
          idx.normPool,
          idx.bonusPool,
          from,
          from,
          idx.textLen[id]!,
          dq,
          idx.primaryOff[id]!,
        )
        if (r.score <= NEG) continue
        if (s.countedEpoch[id] !== qid) {
          s.countedEpoch[id] = qid
          total++
        }
        heapOffer(s, id, r.score + idx.staticPrior[id]! - TYPO_PENALTY)
      }
      dq[i] = savedA
      dq[i + 1] = savedB
    }
    s.epoch++
  }

  // extract top-K (best-first), deduped, applying rank hysteresis
  const tHeap0 = performance.now()
  const k = Math.min(s.heapSize, capacity)
  const order: number[] = []
  for (let i = 0; i < k; i++) order.push(i)
  order.sort((a, b) => {
    const sa = hysteresisScore(s, s.heapIds[a]!, s.heapScores[a]!)
    const sb = hysteresisScore(s, s.heapIds[b]!, s.heapScores[b]!)
    return sb - sa || s.heapIds[a]! - s.heapIds[b]!
  })
  const emitted = new Set<number>()
  const uniqueOrder: number[] = []
  for (const hi of order) {
    if (emitted.has(s.heapIds[hi]!)) continue
    emitted.add(s.heapIds[hi]!)
    uniqueOrder.push(hi)
  }
  // record visibility for next-query stickiness
  s.visCount = Math.min(uniqueOrder.length, s.visIds.length)
  for (let i = 0; i < s.visCount; i++) {
    s.visIds[i] = s.heapIds[uniqueOrder[i]!]!
    s.visOrder[i] = i
  }
  const tHeap1 = performance.now()

  const tMat0 = performance.now()
  const pageIds: number[] = []
  const pageScores: number[] = []
  const pagePositions: Array<number[] | undefined> = []
  const pageBase: number[] = []
  for (let i = offset; i < Math.min(offset + limit, uniqueOrder.length); i++) {
    const hi = uniqueOrder[i]!
    const id = s.heapIds[hi]!
    // reconstruct highlight positions for final-K rows only (doc §Phase B)
    const posArr: number[] = []
    const from = idx.textOff[id]!
    for (const q of tokens) {
      const r = MatcherScore.matchToken(idx.normPool, idx.bonusPool, from, from, idx.textLen[id]!, q, idx.primaryOff[id]!)
      const pos = matchedPositions()
      for (let k = 0; k < r.count && posArr.length < 64; k++) posArr.push(pos[k]! - from)
    }
    posArr.sort((a, b) => a - b)
    let w = 1
    for (let r = 1; r < posArr.length; r++) if (posArr[r] !== posArr[w - 1]) posArr[w++] = posArr[r]!
    posArr.length = w
    pageIds.push(id)
    pageScores.push(s.heapScores[hi]!)
    pagePositions.push(posArr.length > 0 ? posArr : undefined)
    pageBase.push(primaryBaseOffset(corpus.rows, id))
  }

  // save state for incremental filter-down (single-token queries)
  if (tokens.length === 1) {
    s.prevQ.set(dq.subarray(0, dlen))
    s.prevQLen = dlen
    s.prevCount = Math.min(s.frontierCount, s.prevFrontier.length)
    s.prevFrontier.set(s.frontier.subarray(0, s.prevCount))
    s.prevCursors.set(s.cursors.subarray(0, s.prevCount))
    s.prevStateValid = true
  } else {
    s.prevStateValid = false
  }
  const tMat1 = performance.now()

  s.timings = {
    generateUs: (tGen1 - tGen0) * 1000,
    scoreUs: (tScore1 - tScore0) * 1000,
    heapUs: (tHeap1 - tHeap0) * 1000,
    materializeUs: (tMat1 - tMat0) * 1000,
    frontier: s.frontierCount,
    scored: scoreCount,
  }

  return {
    ids: pageIds,
    scores: pageScores,
    positions: pagePositions,
    baseOffsets: pageBase,
    total,
  }
}

function foldLowerCode(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c
}

function prefixOf(prev: Uint16Array, prevLen: number, next: Uint16Array, nextLen: number): boolean {
  if (nextLen !== prevLen + 1) return false
  for (let i = 0; i < prevLen; i++) if (prev[i] !== next[i]) return false
  return true
}

function findCharAfter(norm: Uint16Array, c: number, from: number, to: number): number {
  for (let i = from; i < to; i++) if (norm[i] === c) return i
  return -1
}

function estimateTokenCost(idx: SearchIndex, tok: Uint16Array, len: number): number {
  if (len >= 3) {
    let cost = 0
    for (let i = 0; i + 2 < len; i++) {
      const g = lookupGram(idx, gramKeyOf(tok, i))
      const ag = lookupAcroGram(idx, gramKeyOf(tok, i))
      if (!g && !ag) return 0 // token impossible in this corpus
      cost += (g ? g.len : 0) + (ag ? ag.len : 0)
      if (cost > 100_000) break
    }
    return cost
  }
  const key = prefixKeyOf(tok, len)
  const p = lookupPrefix(idx, key)
  return p ? p.len : 0
}

function gramKeyOf(tok: Uint16Array, i: number): number {
  return (MatcherIndexFold(tok[i]!) << 12) | (MatcherIndexFold(tok[i + 1]!) << 6) | MatcherIndexFold(tok[i + 2]!)
}

function prefixKeyOf(tok: Uint16Array, len: number): number {
  let key = len << 24
  for (let i = 0; i < 4; i++) key |= (i < len ? MatcherIndexFold(tok[i]!) : 0) << (18 - i * 6)
  return key
}

// local re-export of the index-side fold to keep keys consistent
function MatcherIndexFold(unit: number): number {
  if (unit >= 97 && unit <= 122) return unit - 97
  if (unit >= 65 && unit <= 90) return unit - 65 + 26
  if (unit >= 48 && unit <= 57) return unit - 48 + 26
  if (unit === 95) return 36
  if (unit === 45) return 37
  if (unit === 46) return 38
  if (unit === 47) return 39
  if (unit === 32) return 40
  return 41
}

function pushFrontier(s: Scratch, id: number): boolean {
  if (s.seenEpoch[id] === s.epoch) return false
  if (s.frontierCount >= s.frontier.length) return false
  s.seenEpoch[id] = s.epoch
  s.frontier[s.frontierCount++] = id
  return true
}

function addChampions(idx: SearchIndex, s: Scratch, tok: Uint16Array, len: number): void {
  const key = prefixKeyOf(tok, Math.min(len, 4))
  const p = lookupPrefix(idx, key)
  if (!p) return
  for (let i = 0; i < p.len; i++) pushFrontier(s, idx.champions[p.off + i]!)
}

function addRareGrams(idx: SearchIndex, s: Scratch, tok: Uint16Array, len: number): void {
  // intersect the rarest grams within each domain (full text + acronym
  // projection); the acronym domain makes gubi -> getUserById indexed intent
  const grams: Array<{ off: number; len: number }> = []
  const agrams: Array<{ off: number; len: number }> = []
  for (let i = 0; i + 2 < len; i++) {
    const key = gramKeyOf(tok, i)
    const g = lookupGram(idx, key)
    if (g) grams.push(g)
    const ag = lookupAcroGram(idx, key)
    if (ag) agrams.push(ag)
  }
  if (grams.length === 0 && agrams.length === 0) return // token cannot exist
  grams.sort((a, b) => a.len - b.len)
  agrams.sort((a, b) => a.len - b.len)
  intersectInto(idx, s, grams.slice(0, 3), idx.postings)
  intersectInto(idx, s, agrams.slice(0, 3), idx.apostings)
}

function intersectInto(
  idx: SearchIndex,
  s: Scratch,
  use: Array<{ off: number; len: number }>,
  pool: Uint32Array,
): void {
  if (use.length === 0) return
  const first = pool.subarray(use[0]!.off, use[0]!.off + use[0]!.len)
  for (let i = 0; i < first.length && s.frontierCount < s.frontier.length; i++) {
    const id = first[i]!
    let inAll = true
    for (let gi = 1; gi < use.length && inAll; gi++) {
      if (!postingContains(pool, use[gi]!, id)) inAll = false
    }
    if (inAll) pushFrontier(s, id)
  }
}

function postingContains(pool: Uint32Array, g: { off: number; len: number }, id: number): boolean {
  let lo = 0
  let hi = g.len - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = pool[g.off + mid]!
    if (v === id) return true
    if (v < id) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

// Complete underfill channel: AND of per-char presence bitmaps over all query
// characters is a superset of every possible subsequence match. Sweeps the
// whole superset with O(1) rejects (seen / too-short / cannot-beat-heap-min)
// and precise validation only for survivors. Visit-capped so pathological
// short-key supersets stay bounded (ascending-id order, deterministic).
// Returns newly matched count.
const SWEEP_VISIT_CAP = 24_000

function bitsetSupersetSweep(
  idx: SearchIndex,
  s: Scratch,
  tokens: Uint16Array[],
  tokLensSum: number,
  qid: number,
): number {
  const words = idx.bitWords
  const acc = new Uint32Array(words)
  const firstBase = MatcherIndexFold(tokens[0]![0]!) * words
  acc.set(idx.charBits.subarray(firstBase, firstBase + words))
  for (const tok of tokens) {
    for (let i = 0; i < tok.length; i++) {
      const base = MatcherIndexFold(tok[i]!) * words
      for (let w = 0; w < words; w++) acc[w] &= idx.charBits[base + w]!
    }
  }
  const m = tokLensSum
  const boundConst = (m + 1) * 36 + MatcherScore.PRIMARY_EXACT_BONUS + 20
  let added = 0
  let visits = 0
  for (let w = 0; w < words && visits < SWEEP_VISIT_CAP; w++) {
    let bits = acc[w]
    while (bits !== 0 && visits < SWEEP_VISIT_CAP) {
      const bit = bits & -bits
      bits ^= bit
      visits++
      const id = (w << 5) | (31 - Math.clz32(bit))
      if (s.seenEpoch[id] === s.epoch) continue
      s.seenEpoch[id] = s.epoch
      if (idx.textLen[id]! < m) continue
      if (s.heapSize >= s.heapCap) {
        const bound = idx.staticPrior[id]! + boundConst
        if (bound <= s.heapScores[0]!) continue
      }
      const sum = scoreCandidateIndex(idx, id, tokens)
      if (sum <= NEG) continue
      if (s.countedEpoch[id] !== qid) {
        s.countedEpoch[id] = qid
        added++
      }
      heapOffer(s, id, sum)
    }
  }
  return added
}

// ---- bounded heap -------------------------------------------------------------
// Min-heap on (score, id): the root is the WORST entry — lowest score, and
// among equal scores the LARGEST id — so the surviving top-K is a canonical
// function of the candidate set, independent of arrival order. This makes
// offset paging stable and recall-vs-oracle comparison tie-exact.
function heapWorse(s: Scratch, a: number, b: number): boolean {
  const sa = s.heapScores[a]!
  const sb = s.heapScores[b]!
  if (sa !== sb) return sa < sb
  return s.heapIds[a]! > s.heapIds[b]!
}

function heapOffer(s: Scratch, id: number, score: number): void {
  if (s.heapSize < s.heapCap) {
    const i = s.heapSize++
    s.heapIds[i] = id
    s.heapScores[i] = score
    siftUp(s, i)
    return
  }
  // enter only if the new entry is BETTER than the root (worst) entry
  const rootScore = s.heapScores[0]!
  const rootId = s.heapIds[0]!
  if (score < rootScore || (score === rootScore && id > rootId)) return
  s.heapIds[0] = id
  s.heapScores[0] = score
  siftDown(s, 0)
}

function siftUp(s: Scratch, i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (!heapWorse(s, i, parent)) break
    swapHeap(s, i, parent)
    i = parent
  }
}

function siftDown(s: Scratch, i: number): void {
  for (;;) {
    const l = i * 2 + 1
    const r = l + 1
    let smallest = i
    if (l < s.heapSize && heapWorse(s, l, smallest)) smallest = l
    if (r < s.heapSize && heapWorse(s, r, smallest)) smallest = r
    if (smallest === i) break
    swapHeap(s, i, smallest)
    i = smallest
  }
}

function swapHeap(s: Scratch, a: number, b: number): void {
  const id = s.heapIds[a]!
  const sc = s.heapScores[a]!
  s.heapIds[a] = s.heapIds[b]!
  s.heapScores[a] = s.heapScores[b]!
  s.heapIds[b] = id
  s.heapScores[b] = sc
}

// ---- hysteresis -----------------------------------------------------------------
function hysteresisScore(s: Scratch, id: number, score: number): number {
  // sticky bonus proportional to the current kth score so it survives the
  // score growth that comes with each appended character
  let adj = score
  for (let i = 0; i < s.visCount; i++) {
    if (s.visIds[i] === id) {
      const kth = s.heapSize > 0 ? Math.abs(s.heapScores[0]!) : 30
      adj += Math.max(STICKY_BONUS, kth >> 3)
      break
    }
  }
  return adj >> BUCKET_SHIFT
}

// ---- directory-completion mode ---------------------------------------------------
function dirPrefixPage<T extends PathEntry | SymbolEntry>(
  corpus: Corpus<T>,
  s: Scratch,
  prefix: string,
  offset: number,
  limit: number,
): CorpusPage<T> {
  const idx = corpus.index
  const hits: Array<{ id: number; score: number }> = []
  for (let id = 0; id < idx.count; id++) {
    if (idx.kind[id] !== 1) continue
    const from = idx.textOff[id]!
    const len = idx.textLen[id]!
    if (len < prefix.length) continue
    let ok = true
    for (let i = 0; i < prefix.length; i++) {
      if (idx.normPool[from + i] !== prefix.charCodeAt(i)) {
        ok = false
        break
      }
    }
    if (ok) hits.push({ id, score: -(len - prefix.length) * 2 - idx.depth[id]! * 3 })
  }
  hits.sort((a, b) => b.score - a.score || a.id - b.id)
  const ids: number[] = []
  const scores: number[] = []
  const positions: Array<number[] | undefined> = []
  const baseOffsets: number[] = []
  for (let i = offset; i < Math.min(offset + limit, hits.length); i++) {
    const h = hits[i]!
    ids.push(h.id)
    scores.push(h.score)
    positions.push(Array.from({ length: prefix.length }, (_, k) => k))
    baseOffsets.push(primaryBaseOffset(corpus.rows, h.id))
  }
  return { ids, scores, positions, baseOffsets, total: hits.length }
}

function primaryBaseOffset(rows: readonly (PathEntry | SymbolEntry)[], id: number): number {
  const row = rows[id]
  if (!row) return 0
  if ("name" in row) return 0
  const p = (row as PathEntry).path
  const core = p.endsWith("/") ? p.length - 1 : p.length
  const slash = p.lastIndexOf("/", core - 1)
  return slash < 0 ? 0 : slash + 1
}

// ---- merge + materialize -----------------------------------------------------------
function merge(fp: CorpusPage<PathEntry>, sp: CorpusPage<SymbolEntry>, prepared: Prepared, offset: number, limit: number): QueryPage {
  const merged: Array<{ norm: number; seq: number; result: UnifiedResult }> = []
  let seq = 0
  for (let i = 0; i < fp.ids.length; i++) {
    const id = fp.ids[i]!
    const row = prepared.paths.rows[id]!
    merged.push({
      norm: fp.scores[i]!,
      seq: seq++,
      result: {
        kind: "file",
        path: row.path,
        type: row.isDir ? "directory" : "file",
        score: fp.scores[i]!,
        positions: fp.positions[i],
        baseOffset: fp.baseOffsets[i],
      },
    })
  }
  for (let i = 0; i < sp.ids.length; i++) {
    const id = sp.ids[i]!
    const row = prepared.symbols.rows[id]!
    merged.push({
      norm: sp.scores[i]!,
      seq: seq++,
      result: {
        kind: "symbol",
        name: row.name,
        symbolKind: row.kind,
        path: row.path,
        line: row.line,
        score: sp.scores[i]!,
        positions: sp.positions[i],
      },
    })
  }
  merged.sort((a, b) => b.norm - a.norm || a.seq - b.seq)
  const total = fp.total + sp.total
  const results = merged.slice(offset, offset + limit).map((m) => m.result)
  return {
    files: fp.ids.map((id, i) => ({
      item: prepared.paths.rows[id]!,
      score: fp.scores[i]!,
      positions: fp.positions[i],
      baseOffset: fp.baseOffsets[i],
    })),
    symbols: sp.ids.map((id, i) => ({
      item: prepared.symbols.rows[id]!,
      score: sp.scores[i]!,
      positions: sp.positions[i],
    })),
    results,
    hasMore: offset + results.length < total,
    total,
  }
}

// ---- stateless convenience API -------------------------------------------------------
export function queryPaths(prepared: Prepared, q: string, opts: QueryOptions = {}): MatchResult<PathEntry>[] {
  return createSession(prepared).query(q, { ...opts, symbols: false }).files
}

export function querySymbols(prepared: Prepared, q: string, opts: QueryOptions = {}): MatchResult<SymbolEntry>[] {
  return createSession(prepared).query(q, { ...opts, symbols: true }).symbols
}

export function query(prepared: Prepared, q: string, opts: QueryOptions = {}): QueryPage {
  return createSession(prepared).query(q, opts)
}

// Test/tool hook: does one text fuzzy-contain one token?
export function tokenMatch(text: string, token: string): boolean {
  const idx = buildIndex([{ text, primaryStart: 0, isDir: false, extRank: 99 }])
  const s = makeScratch(1)
  const tok = new Uint16Array(Math.min(token.length, QUERY_MAX))
  let n = 0
  for (let i = 0; i < token.length && n < QUERY_MAX; i++) tok[n++] = foldLowerCode(token.charCodeAt(i))
  const r = MatcherScore.matchToken(
    idx.normPool,
    idx.bonusPool,
    idx.textOff[0]!,
    idx.textOff[0]!,
    idx.textLen[0]!,
    tok.subarray(0, n),
    idx.primaryOff[0]!,
  )
  void s
  return r.score > NEG
}
