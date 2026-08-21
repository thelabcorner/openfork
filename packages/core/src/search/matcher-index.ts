export * as MatcherIndex from "./matcher-index"

// Phase A candidate-generation index: structure-of-arrays over candidates with
// a normalized Uint16 text pool, trigram postings (open-address hash), packed
// prefix/boundary champion lists, boundary-acronym projection, and
// char-presence bitsets. Built once per index revision; query path reads only
// typed arrays.

import { computeBonus } from "./matcher-score"

export const PREFIX_CHAMPIONS = 128
const ALPHABET = 48

// One candidate's raw input: display text, where its primary field
// (basename/name) starts inside that text, and static metadata.
export interface IndexDoc {
  readonly text: string
  readonly primaryStart: number
  readonly isDir: boolean
  readonly extRank: number
}

export interface SearchIndex {
  readonly count: number

  // normalized full text pool (ASCII-folded lowercase UTF-16 units)
  readonly normPool: Uint16Array
  readonly textOff: Uint32Array
  readonly textLen: Uint32Array
  // primary field start (absolute pool coords) — basename for paths, name for symbols
  readonly primaryOff: Uint32Array

  // per-candidate bonus bytes (flattened), offsets mirror textOff
  readonly bonusPool: Uint8Array

  // boundary-acronym projection of the PRIMARY field (e.g. getUserById -> gubi)
  readonly acroPool: Uint16Array
  readonly acroOff: Uint32Array
  readonly acroLen: Uint16Array

  // entity metadata
  readonly kind: Uint8Array // 0 = file, 1 = directory
  readonly depth: Uint8Array
  readonly extRank: Uint8Array
  readonly staticPrior: Int16Array

  // trigram postings over the full normalized text
  readonly gramMask: number
  readonly gramKey: Int32Array // open-address; -1 empty
  readonly gramOff: Uint32Array
  readonly gramLen: Uint32Array
  readonly postings: Uint32Array // sorted, deduped id lists

  // trigram postings over the ACRONYM projection (gubi -> getUserById):
  // acronym intent is indexed, not discovered by scanning
  readonly agramMask: number
  readonly agramKey: Int32Array
  readonly agramOff: Uint32Array
  readonly agramLen: Uint32Array
  readonly apostings: Uint32Array

  // packed prefix/boundary champions (best-first)
  readonly prefixMask: number
  readonly prefixKey: Int32Array // open-address; -1 empty
  readonly prefixOff: Uint32Array
  readonly prefixLen: Uint16Array
  readonly champions: Uint32Array

  // char-presence bitsets: [foldedChar][word]
  readonly charBits: Uint32Array
  readonly bitWords: number

  readonly approxBytes: number
}

// ---- folded alphabet --------------------------------------------------------
// canonical case-folded alphabet: a-z -> 0..25, 0-9 -> 26..35,
// _ - . / space -> 36..40, everything else -> 41+
function foldChar(c: number): number {
  if (c >= 65 && c <= 90) c += 32 // fold uppercase into the lowercase domain
  if (c >= 97 && c <= 122) return c - 97
  if (c >= 48 && c <= 57) return c - 48 + 26
  if (c === 95) return 36
  if (c === 45) return 37
  if (c === 46) return 38
  if (c === 47) return 39
  if (c === 32) return 40
  return 41
}

// ASCII fold to lowercase code unit; non-ASCII passes through unchanged
// (case-insensitivity is ASCII-only in v1 — keeps positions 1:1)
function isBoundaryCode(prev: number, c: number): boolean {
  if (prev === 47 || prev === 95 || prev === 45 || prev === 46 || prev === 32) return true
  return prev >= 97 && prev <= 122 && c >= 65 && c <= 90
}

// pack up to 4 folded chars + length into one uint32 key
function packPrefixKey(chars: number[], len: number): number {
  let key = len << 24
  for (let i = 0; i < 4; i++) key |= (chars[i] ?? 0) << (18 - i * 6)
  return key
}

function packGramKey(a: number, b: number, c: number): number {
  return (a << 12) | (b << 6) | c
}

// ---- build ------------------------------------------------------------------
export function buildIndex(docs: readonly IndexDoc[]): SearchIndex {
  const count = docs.length
  const chars: number[] = [0, 0, 0, 0]

  // pass 1: sizes
  let totalText = 0
  let totalAcro = 0
  const depths = new Uint8Array(count)
  for (let id = 0; id < count; id++) {
    const d = docs[id]!
    totalText += d.text.length
    let depth = 0
    for (let i = 0; i < d.text.length; i++) if (d.text.charCodeAt(i) === 47) depth++
    depths[id] = Math.min(255, depth)
    // acronym projection length = boundary count within primary
    const pStart = d.primaryStart
    const pLen = d.text.length - pStart
    let acro = 0
    for (let i = 0; i < pLen; i++) {
      const c = d.text.charCodeAt(pStart + i)
      const prev = i === 0 ? 0 : d.text.charCodeAt(pStart + i - 1)
      if (i === 0 || isBoundaryCode(prev, c)) acro++
    }
    totalAcro += acro
  }

  const normPool = new Uint16Array(totalText)
  const textOff = new Uint32Array(count)
  const textLen = new Uint32Array(count)
  const primaryOff = new Uint32Array(count)
  const bonusPool = new Uint8Array(totalText)
  const acroPool = new Uint16Array(totalAcro)
  const acroOff = new Uint32Array(count)
  const acroLen = new Uint16Array(count)
  const kind = new Uint8Array(count)
  const extRankArr = new Uint8Array(count)
  const staticPrior = new Int16Array(count)

  const grams = new Map<number, number[]>()
  const agrams = new Map<number, number[]>()
  const prefixes = new Map<number, number[]>()
  const perDocGrams = new Set<number>()
  const perDocAgrams = new Set<number>()
  const perDocPrefixes = new Set<number>()

  let pos = 0
  let apos = 0
  for (let id = 0; id < count; id++) {
    const d = docs[id]!
    const n = d.text.length
    textOff[id] = pos
    textLen[id] = n
    kind[id] = d.isDir ? 1 : 0
    extRankArr[id] = Math.min(255, d.extRank)

    // normalize: keep ORIGINAL case (camel humps feed bonuses + the acronym
    // projection); query-side matching folds case at compare time
    const from = pos
    for (let i = 0; i < n; i++) normPool[pos + i] = d.text.charCodeAt(i)
    const bonus = computeBonus(normPool, from, n)
    bonusPool.set(bonus, from)

    // static prior (fixed-point seam; starting weights per research doc §4.1):
    // extension affinity + short-primary preference; dirs compete equally
    const primaryStartAbs = from + d.primaryStart
    primaryOff[id] = primaryStartAbs
    const primaryLen = n - d.primaryStart
    staticPrior[id] =
      (d.extRank < 6 ? (6 - d.extRank) * 4 : 0) + (primaryLen < 24 ? 24 - primaryLen : 0)

    // acronym projection over the primary field
    acroOff[id] = apos
    let alen = 0
    for (let i = 0; i < primaryLen; i++) {
      const c = normPool[primaryStartAbs + i]!
      const prev = i === 0 ? 0 : normPool[primaryStartAbs + i - 1]!
      if (i === 0 || isBoundaryCode(prev, c)) acroPool[apos + alen++] = c
    }
    acroLen[id] = alen
    apos += alen

    // distinct trigrams of the acronym projection (acronym-intent channel)
    perDocAgrams.clear()
    if (alen >= 3) {
      for (let i = 0; i + 2 < alen; i++) {
        const key = packGramKey(
          foldChar(acroPool[acroOff[id]! + i]!),
          foldChar(acroPool[acroOff[id]! + i + 1]!),
          foldChar(acroPool[acroOff[id]! + i + 2]!),
        )
        if (!perDocAgrams.has(key)) {
          perDocAgrams.add(key)
          let list = agrams.get(key)
          if (!list) agrams.set(key, (list = []))
          list.push(id)
        }
      }
    }

    // distinct trigrams of the full text
    perDocGrams.clear()
    if (n >= 3) {
      for (let i = 0; i + 2 < n; i++) {
        const key = packGramKey(
          foldChar(normPool[from + i]!),
          foldChar(normPool[from + i + 1]!),
          foldChar(normPool[from + i + 2]!),
        )
        if (!perDocGrams.has(key)) {
          perDocGrams.add(key)
          let list = grams.get(key)
          if (!list) grams.set(key, (list = []))
          list.push(id)
        }
      }
    }

    // prefix keys: primary prefixes (1..4) + every boundary position's next
    // up-to-4 chars across the FULL text (segment starts, humps, separators)
    perDocPrefixes.clear()
    const addPrefix = (start: number, len: number) => {
      for (let k = 0; k < len; k++) chars[k] = foldChar(normPool[start + k]!)
      const key = packPrefixKey(chars, len)
      if (!perDocPrefixes.has(key)) {
        perDocPrefixes.add(key)
        let list = prefixes.get(key)
        if (!list) prefixes.set(key, (list = []))
        list.push(id)
      }
    }
    const plen = Math.min(4, primaryLen)
    for (let l = 1; l <= plen; l++) addPrefix(primaryStartAbs, l)
    for (let b = 1; b < n; b++) {
      if (bonus[b]! >= 7 /* delimiter or white or camel */) {
        const avail = Math.min(4, n - b)
        for (let l = 1; l <= avail; l++) addPrefix(from + b, l)
      }
    }
    // acronym-prefix keys so "gu" finds getUserById via projection
    for (let l = 1; l <= Math.min(4, alen); l++) {
      for (let k = 0; k < l; k++) chars[k] = foldChar(acroPool[acroOff[id]! + k]!)
      const key = packPrefixKey(chars, l)
      if (!perDocPrefixes.has(key)) {
        perDocPrefixes.add(key)
        let list = prefixes.get(key)
        if (!list) prefixes.set(key, (list = []))
        list.push(id)
      }
    }

    pos += n
  }

  // pass 2: flatten trigram postings (sorted asc for intersection galloping)
  const gramCount = grams.size
  const gramMask = maskFor(gramCount)
  const gramKey = new Int32Array(gramMask).fill(-1)
  const gramOff = new Uint32Array(gramMask)
  const gramLen = new Uint32Array(gramMask)
  const postingLists = [...grams.entries()].sort((a, b) => a[0] - b[0])
  const postingsTotal = postingLists.reduce((acc, [, ids]) => acc + ids.length, 0)
  const postings = new Uint32Array(postingsTotal)
  let poff = 0
  for (const [key, ids] of postingLists) {
    ids.sort((a, b) => a - b)
    postings.set(ids, poff)
    insertGram(gramKey, gramOff, gramLen, gramMask, key, poff, ids.length)
    poff += ids.length
  }

  // pass 2b: flatten acronym-gram postings
  const agramCount = agrams.size
  const agramMask = maskFor(agramCount)
  const agramKey = new Int32Array(agramMask).fill(-1)
  const agramOff = new Uint32Array(agramMask)
  const agramLen = new Uint32Array(agramMask)
  const apostingLists = [...agrams.entries()].sort((a, b) => a[0] - b[0])
  const apostingsTotal = apostingLists.reduce((acc, [, ids]) => acc + ids.length, 0)
  const apostings = new Uint32Array(apostingsTotal)
  let apoff = 0
  for (const [key, ids] of apostingLists) {
    ids.sort((a, b) => a - b)
    apostings.set(ids, apoff)
    insertGram(agramKey, agramOff, agramLen, agramMask, key, apoff, ids.length)
    apoff += ids.length
  }

  // pass 3: flatten prefix champions (best-first by static prior, then
  // shorter primary, then id — deterministic)
  const prefixCount = prefixes.size
  const prefixMask = maskFor(prefixCount)
  const prefixKey = new Int32Array(prefixMask).fill(-1)
  const prefixOff = new Uint32Array(prefixMask)
  const prefixLen = new Uint16Array(prefixMask)
  const champScratch: number[][] = []
  let champTotal = 0
  for (const [, ids] of [...prefixes.entries()].sort((a, b) => a[0] - b[0])) {
    const ranked = ids
      .slice()
      .sort((a, b) => staticPrior[b]! - staticPrior[a]! || a - b)
      .slice(0, PREFIX_CHAMPIONS)
    champScratch.push(ranked)
    champTotal += ranked.length
  }
  const champions = new Uint32Array(champTotal)
  let coff = 0
  let ci = 0
  for (const [key] of [...prefixes.entries()].sort((a, b) => a[0] - b[0])) {
    const ranked = champScratch[ci++]!
    insertPrefix(prefixKey, prefixOff, prefixLen, prefixMask, key, coff, ranked.length)
    for (let k = 0; k < ranked.length; k++) champions[coff + k] = ranked[k]!
    coff += ranked.length
  }

  // pass 4: char-presence bitsets over the full text
  const bitWords = (count >> 5) + 1
  const charBits = new Uint32Array(ALPHABET * bitWords)
  for (let id = 0; id < count; id++) {
    const from = textOff[id]!
    const n = textLen[id]!
    const word = id >> 5
    const bit = 1 << (id & 31)
    for (let i = 0; i < n; i++) charBits[foldChar(normPool[from + i]!) * bitWords + word] |= bit
  }

  const approxBytes =
    normPool.byteLength +
    bonusPool.byteLength +
    acroPool.byteLength +
    postings.byteLength +
    apostings.byteLength +
    champions.byteLength +
    charBits.byteLength +
    (textOff.byteLength + textLen.byteLength + primaryOff.byteLength + acroOff.byteLength + acroLen.byteLength + kind.byteLength + depthByteLen(count) + extRankArr.byteLength + staticPrior.byteLength) +
    (gramKey.byteLength + gramOff.byteLength + gramLen.byteLength + agramKey.byteLength + agramOff.byteLength + agramLen.byteLength + prefixKey.byteLength + prefixOff.byteLength + prefixLen.byteLength)

  return {
    count,
    normPool,
    textOff,
    textLen,
    primaryOff,
    bonusPool,
    acroPool,
    acroOff,
    acroLen,
    kind,
    depth: depths,
    extRank: extRankArr,
    staticPrior,
    gramMask,
    gramKey,
    gramOff,
    gramLen,
    postings,
    agramMask,
    agramKey,
    agramOff,
    agramLen,
    apostings,
    prefixMask,
    prefixKey,
    prefixOff,
    prefixLen,
    champions,
    charBits,
    bitWords,
    approxBytes,
  }
}

function depthByteLen(count: number): number {
  return count
}

// open-address table sizing: always at least one empty slot (mask >= 4 and
// load <= 50%), so absent-key probes always terminate
function maskFor(count: number): number {
  return Math.max(4, 1 << Math.ceil(Math.log2(Math.max(2, count * 2))))
}

function insertGram(
  keys: Int32Array,
  offs: Uint32Array,
  lens: Uint32Array,
  mask: number,
  key: number,
  off: number,
  len: number,
): void {
  let slot = (Math.imul(key, 0x9e3779b1) >>> 0) & (mask - 1)
  while (keys[slot] !== -1) slot = (slot + 1) & (mask - 1)
  keys[slot] = key
  offs[slot] = off
  lens[slot] = len
}

function insertPrefix(
  keys: Int32Array,
  offs: Uint32Array,
  lens: Uint16Array,
  mask: number,
  key: number,
  off: number,
  len: number,
): void {
  let slot = (Math.imul(key, 0x85ebca6b) >>> 0) & (mask - 1)
  while (keys[slot] !== -1) slot = (slot + 1) & (mask - 1)
  keys[slot] = key
  offs[slot] = off
  lens[slot] = len
}

// ---- query-side lookups ------------------------------------------------------
export function lookupGram(idx: SearchIndex, key: number): { off: number; len: number } | undefined {
  let slot = (Math.imul(key, 0x9e3779b1) >>> 0) & (idx.gramMask - 1)
  for (let probes = 0; probes < idx.gramMask; probes++) {
    const k = idx.gramKey[slot]!
    if (k === -1) return undefined
    if (k === key) return { off: idx.gramOff[slot]!, len: idx.gramLen[slot]! }
    slot = (slot + 1) & (idx.gramMask - 1)
  }
  return undefined
}

export function lookupAcroGram(idx: SearchIndex, key: number): { off: number; len: number } | undefined {
  let slot = (Math.imul(key, 0x9e3779b1) >>> 0) & (idx.agramMask - 1)
  for (let probes = 0; probes < idx.agramMask; probes++) {
    const k = idx.agramKey[slot]!
    if (k === -1) return undefined
    if (k === key) return { off: idx.agramOff[slot]!, len: idx.agramLen[slot]! }
    slot = (slot + 1) & (idx.agramMask - 1)
  }
  return undefined
}

export function lookupPrefix(idx: SearchIndex, key: number): { off: number; len: number } | undefined {
  let slot = (Math.imul(key, 0x85ebca6b) >>> 0) & (idx.prefixMask - 1)
  for (let probes = 0; probes < idx.prefixMask; probes++) {
    const k = idx.prefixKey[slot]!
    if (k === -1) return undefined
    if (k === key) return { off: idx.prefixOff[slot]!, len: idx.prefixLen[slot]! }
    slot = (slot + 1) & (idx.prefixMask - 1)
  }
  return undefined
}
