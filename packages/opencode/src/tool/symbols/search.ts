import { Effect } from "effect"
import path from "path"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Match } from "@opencode-ai/schema/filesystem"
import type { OutlineCacheRef, OutlineSymbol } from "./outline"
import { getOutline } from "./outline"

/**
 * `search` action (design §5.3): grep-anchored candidate discovery, then
 * tree-sitter classification and ranking.
 */

export const MAX_PARSE_FILES = 100
const MAX_QUERY = 200

/** Regex-escape a user query (design §3.3). */
export const escapeRegex = (query: string) => query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Word-boundary grep pattern for a query. `\b` is only added at edges where
 * the query has a word character; a query starting with a non-word char falls
 * back to a plain escaped match (design edge-case table).
 *
 * The anchor uses a *leading* boundary only (not trailing): candidates must
 * include prefix matches ("Sess" → `Session`) so ranking can order them.
 * Precision is guaranteed by the tree-sitter classification step — grep only
 * narrows candidate files; strings/comments never contain identifier nodes.
 */
export const wordPattern = (query: string) => {
  const escaped = escapeRegex(query)
  const lead = /^[\p{L}\p{N}_]/u.test(query) ? "\\b" : ""
  return `${lead}${escaped}`
}

export interface SearchHit {
  file: string
  relFile: string
  symbol: OutlineSymbol
  rank: number
}

/** Match-level of a symbol name against the query (0 = best). */
function matchRank(query: string, name: string): number {
  if (name === query) return 0
  if (name.toLowerCase() === query.toLowerCase()) return 1
  if (name.startsWith(query)) return 2
  if (name.includes(query)) return 3
  if (isSubsequence(query, name)) return 4
  return -1
}

/** Subsequence match with at most 2 skips (design §5.3). */
function isSubsequence(query: string, name: string): boolean {
  if (query.length === 0) return false
  let qi = 0
  let skips = 0
  for (const ch of name) {
    if (query[qi] === ch) {
      qi++
      if (qi === query.length) return true
    } else if (qi > 0) {
      skips++
      if (skips > 2) return false
    }
  }
  return qi === query.length
}

const KIND_ORDER: Record<string, number> = {
  class: 0,
  interface: 1,
  type: 2,
  enum: 3,
  function: 4,
  const: 5,
  variable: 6,
  method: 7,
  property: 8,
  parameter: 9,
  import: 10,
  module: 11,
}

export function validateQuery(query: string) {
  if (!query) throw new Error("query is required (search/usages)")
  if (query.length > MAX_QUERY) throw new Error(`query too long (max ${MAX_QUERY} chars)`)
}

export const findDefinitions = (
  fs: FSUtil.Interface,
  cache: OutlineCacheRef,
  cwd: string,
  matches: readonly Match[],
  query: string,
  kind?: string,
  limit = 50,
): Effect.Effect<{ hits: SearchHit[]; files: number; capped: boolean; skipped: number }> =>
  Effect.gen(function* () {
    const byFile = new Map<string, Match[]>()
    for (const match of matches) {
      const file = match.entry.path
      const list = byFile.get(file) ?? []
      list.push(match)
      byFile.set(file, list)
    }

    const hits: SearchHit[] = []
    let skipped = 0
    let files = 0
    for (const [relFile] of byFile) {
      if (files >= MAX_PARSE_FILES) {
        skipped += byFile.size - files
        break
      }
      files++
      const abs = resolveCandidate(cwd, relFile)
      const outline = yield* getOutline(fs, cache, abs)
      if (!outline) continue
      for (const symbol of outline.symbols) {
        if (kind && symbol.kind !== kind) continue
        const rank = matchRank(query, symbol.name)
        if (rank === -1) continue
        hits.push({ file: abs, relFile, symbol, rank })
      }
    }

    const sorted = hits.sort(compareHits(query))
    const capped = sorted.length > limit
    return { hits: sorted.slice(0, limit), files, capped, skipped }
  })

const resolveCandidate = (cwd: string, rel: string) => path.join(cwd, ...rel.split("/"))

function compareHits(query: string) {
  const ql = query.toLowerCase()
  return (a: SearchHit, b: SearchHit) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    const ka = KIND_ORDER[a.symbol.kind] ?? 99
    const kb = KIND_ORDER[b.symbol.kind] ?? 99
    if (ka !== kb) return ka - kb
    if (a.symbol.name !== b.symbol.name) {
      const exactA = a.symbol.name.toLowerCase() === ql ? 0 : 1
      const exactB = b.symbol.name.toLowerCase() === ql ? 0 : 1
      if (exactA !== exactB) return exactA - exactB
      return a.symbol.name.localeCompare(b.symbol.name)
    }
    const depthA = a.relFile.split("/").length
    const depthB = b.relFile.split("/").length
    if (depthA !== depthB) return depthA - depthB
    return a.symbol.line - b.symbol.line
  }
}

export * as SymbolsSearch from "./search"
