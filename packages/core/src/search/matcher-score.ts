export * as MatcherScore from "./matcher-score"

// Phase B precise scorer: fzf-v2-inspired greedy forward match + backward span
// tightening + affine-gap optimal-alignment DP on the narrow window, with
// backtracking position reconstruction into caller-owned scratch. Operates on
// the normalized Uint16 text pool — zero allocations.

export const SCORE_MATCH = 16
export const SCORE_MATCH_DIRNAME = 9
export const GAP_START = -3
export const GAP_EXT = -1
export const BONUS_BOUNDARY_WHITE = 10
export const BONUS_BOUNDARY_DELIMITER = 9
export const BONUS_CAMEL = 7
export const BONUS_CONSECUTIVE = 4
export const BONUS_NON_WORD = 8
export const FIRST_CHAR_MULT = 2

export const NEG = -1 << 30

// ---- shared DP scratch (module-local, grown on demand) ---------------------
let HBUF = new Int32Array(1024)
let EBUF = new Int32Array(1024)
let POSBUF = new Int32Array(256)

function ensureBufs(cells: number) {
  if (HBUF.length < cells) {
    HBUF = new Int32Array(cells)
    EBUF = new Int32Array(cells)
  }
}

// ---- bonuses ----------------------------------------------------------------
// bonus[i] depends only on the text around i; computed once at prepare time.
// The pool preserves ORIGINAL case so camel humps stay detectable; query-side
// comparisons fold case at match time.
export function computeBonus(norm: Uint16Array, from: number, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const c = norm[from + i]!
    const prev = i === 0 ? 0 : norm[from + i - 1]!
    let b = 0
    if (i === 0) b = BONUS_BOUNDARY_WHITE
    else if (prev === 47 /* / */) b = BONUS_BOUNDARY_DELIMITER
    else if (isBoundary(prev)) b = BONUS_BOUNDARY_WHITE
    else if (isCamelHump(prev, c)) b = BONUS_CAMEL
    else if (isNonWord(c)) b = BONUS_NON_WORD
    out[i] = b
  }
  return out
}

function isBoundary(c: number): boolean {
  return c === 47 || c === 95 || c === 45 || c === 46 || c === 32
}
function isNonWord(c: number): boolean {
  return c === 45 || c === 46 || c === 95 || c === 32
}
function isCamelHump(prev: number, c: number): boolean {
  return prev >= 97 && prev <= 122 && c >= 65 && c <= 90
}

// case-fold one code unit for matching (queries are pre-lowercased)
function fold(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c
}

export function foldUnit(c: number): number {
  return fold(c)
}

// fixed-point primary-field bonuses (research doc §4.1): exact primary-name
// match +40, primary prefix +20 — lets an intended folder/file basename beat
// the flood of dirname-only matches
export const PRIMARY_EXACT_BONUS = 40
export const PRIMARY_PREFIX_BONUS = 20

export function primaryPrefixBonus(
  norm: Uint16Array,
  primaryStart: number,
  primaryLen: number,
  q: Uint16Array,
): number {
  if (primaryLen < q.length || q.length === 0) return 0
  for (let i = 0; i < q.length; i++) {
    if (fold(norm[primaryStart + i]!) !== q[i]) return 0
  }
  return primaryLen === q.length ? PRIMARY_EXACT_BONUS : PRIMARY_PREFIX_BONUS
}

// basename/primary chars worth full SCORE_MATCH, directory chars less — dirs
// and files are treated identically (their own last segment is the primary)
function matchVal(i: number, primaryStart: number): number {
  return i >= primaryStart ? SCORE_MATCH : SCORE_MATCH_DIRNAME
}

// score of a contiguous occurrence of q starting at idx (absolute pool coords)
export function occurrenceScore(
  norm: Uint16Array,
  bonus: Uint8Array,
  bonusFrom: number,
  q: Uint16Array,
  idx: number,
  primaryStart: number,
): number {
  let s = 0
  for (let j = 0; j < q.length; j++) {
    const i = idx + j
    s +=
      matchVal(i, primaryStart) +
      (j === 0 ? bonus[i - bonusFrom]! * FIRST_CHAR_MULT : Math.max(bonus[i - bonusFrom]!, BONUS_CONSECUTIVE))
  }
  return s
}

// O(1) upper bound for ANY occurrence starting at idx
export function occurrenceBound(
  bonus: Uint8Array,
  bonusFrom: number,
  qLen: number,
  idx: number,
  primaryStart: number,
): number {
  return (
    matchVal(idx, primaryStart) +
    bonus[idx - bonusFrom]! * FIRST_CHAR_MULT +
    (qLen - 1) * (SCORE_MATCH + BONUS_CONSECUTIVE)
  )
}

export interface TokenMatch {
  score: number
  count: number
}

// Full token match against one candidate's text slice [from, from+len).
// Absolute pool coordinates in, positions written absolute into POSBUF.
export function matchToken(
  norm: Uint16Array,
  bonus: Uint8Array,
  bonusFrom: number,
  from: number,
  len: number,
  q: Uint16Array,
  primaryStart: number,
): TokenMatch {
  const n = len
  const m = q.length
  if (m === 0) return { score: 0, count: 0 }
  if (m > n) return { score: NEG, count: 0 }

  // -- contiguous fast path: best of the first few occurrences --
  let bestScore = NEG
  let bestIdx = -1
  let scanFrom = from
  const lastStart = from + n - m
  for (let probe = 0; probe < 8; probe++) {
    const idx = indexOfPool(norm, q, scanFrom, lastStart)
    if (idx < 0) break
    const s = occurrenceScore(norm, bonus, bonusFrom, q, idx, primaryStart)
    if (s > bestScore) {
      bestScore = s
      bestIdx = idx
    }
    if (bonus[idx - bonusFrom]! >= BONUS_BOUNDARY_DELIMITER) break
    scanFrom = idx + 1
  }
  if (bestIdx >= 0) {
    if (POSBUF.length < m) POSBUF = new Int32Array(m * 2)
    for (let j = 0; j < m; j++) POSBUF[j] = bestIdx + j
    return { score: bestScore, count: m }
  }

  // -- scattered: greedy forward scan rejects hard negatives cheaply --
  let end = -1
  scanFrom = from
  for (let j = 0; j < m; j++) {
    const idx = indexOfCharFold(norm, q[j]!, scanFrom, from + n)
    if (idx < 0) return { score: NEG, count: 0 }
    scanFrom = idx + 1
    end = idx
  }
  let to = from + n
  let start = 0
  for (let j = m - 1; j >= 0; j--) {
    const idx = lastIndexOfCharFold(norm, q[j]!, from, to)
    if (idx < 0) return { score: NEG, count: 0 }
    to = idx
    start = idx
  }

  // -- optimal-alignment DP over [start..end] --
  const W = end - start + 1
  ensureBufs(W * m)
  const H = HBUF
  const E = EBUF
  bestScore = NEG
  let bestRow = -1
  for (let j = 0; j < m; j++) {
    H[j] = NEG
    E[j] = -1
  }
  for (let i = 0; i < W; i++) {
    const ci = start + i
    const pc = fold(norm[ci]!)
    const rowBase = i * m
    const prevBase = i > 0 ? (i - 1) * m : -m
    for (let j = 0; j < m; j++) {
      const cur = rowBase + j
      const up = prevBase + j
      const diag = j > 0 ? prevBase + (j - 1) : -1
      let best = i > 0 ? H[up]! : NEG
      let bestE = i > 0 ? E[up]! : -1
      if (pc === q[j]) {
        let sc: number
        if (j === 0) {
          sc = matchVal(ci, primaryStart) + bonus[ci - bonusFrom]! * FIRST_CHAR_MULT
        } else if (diag < 0 || H[diag]! <= NEG) {
          sc = NEG
        } else {
          const ph = H[diag]!
          const prevE = E[diag]!
          const b = bonus[ci - bonusFrom]!
          if (prevE === ci - 1) {
            sc = ph + matchVal(ci, primaryStart) + Math.max(b, BONUS_CONSECUTIVE)
          } else {
            const g = ci - prevE - 1
            sc = ph + matchVal(ci, primaryStart) + b + GAP_START + GAP_EXT * (g - 1)
          }
        }
        if (sc >= best) {
          best = sc
          bestE = ci
        }
      }
      H[cur] = best
      E[cur] = bestE
    }
    const lastCell = H[rowBase + (m - 1)]!
    if (lastCell > bestScore) {
      bestScore = lastCell
      bestRow = i
    }
  }
  if (bestScore <= NEG || bestRow < 0) return { score: NEG, count: 0 }

  // backtrack: E[cur] === ci uniquely marks cells that matched pattern[j] at ci
  if (POSBUF.length < m) POSBUF = new Int32Array(m * 2)
  let count = 0
  let bi = bestRow
  let bj = m - 1
  while (bj >= 0 && bi >= 0) {
    const cur = bi * m + bj
    const ci = start + bi
    if (H[cur]! > NEG && E[cur] === ci && fold(norm[ci]!) === q[bj]) {
      POSBUF[count++] = ci
      bj--
    }
    bi--
  }
  return { score: bestScore, count }
}

export function matchedPositions(): Int32Array {
  return POSBUF
}

// ---- pool scan primitives ---------------------------------------------------
function indexOfPool(norm: Uint16Array, q: Uint16Array, from: number, lastStart: number): number {
  const c0 = q[0]!
  for (let i = from; i <= lastStart; i++) {
    if (fold(norm[i]!) !== c0) continue
    let ok = true
    for (let j = 1; j < q.length; j++) {
      if (fold(norm[i + j]!) !== q[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

function indexOfCharFold(norm: Uint16Array, c: number, from: number, to: number): number {
  for (let i = from; i < to; i++) if (fold(norm[i]) === c) return i
  return -1
}

function lastIndexOfCharFold(norm: Uint16Array, c: number, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (fold(norm[i]) === c) return i
  return -1
}
