export * as MemoryAnchors from "./anchors"

import type { MemorySchema } from "./schema"

/**
 * Code-aware lexical normalization.
 *
 * Coding-agent memory is queried with filenames, symbols, error codes, package
 * names, commands and commit SHAs. Those strings carry far more discriminative
 * information than ordinary prose, so exact anchor lookup plus identifier
 * decomposition gives lexical retrieval most of the reach of an embedding
 * without a model call (INV-10).
 */

const MAX_ANCHORS = 32
const MIN_LENGTH = 3

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "because", "should",
  "would", "could", "must", "not", "are", "was", "were", "has", "have", "had", "does", "did", "use", "uses",
  "used", "using", "make", "makes", "need", "needs", "want", "wants", "always", "never", "instead",
  "here", "there", "what", "which", "they", "them", "their", "its", "is", "be", "of", "on",
  "at", "as", "by", "or", "if", "so", "we", "you", "your", "our", "can", "may", "will", "get", "got", "set",
  "add", "new", "old", "now", "only", "also", "more", "most", "some", "any", "all", "but", "via", "per",
])

const HEX = /^[0-9a-f]{7,40}$/i
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|c|h|cpp|hpp|json|toml|ya?ml|md|sh|bash|zsh|css|scss|html|vue|svelte|sql|proto|graphql|lock)$/i
const PATHY = /[\\/]/
const ERRORISH = /^(err|e)[A-Z0-9_]*$|^[A-Z][A-Z0-9]*[_-]?\d{2,}$/i
const UPPER_ERROR = /^[A-Z][A-Z0-9_]{3,}$/
const COMMAND_HEAD = /^(npm|npx|pnpm|yarn|bun|bunx|node|deno|git|gh|cargo|go|make|cmake|python3?|pip3?|poetry|uv|pytest|jest|vitest|docker|docker-compose|kubectl|helm|terraform|aws|gcloud|az|systemctl|brew|apt|apk|curl|wget|tsgo|tsc|eslint|prettier|biome|ruff|mypy)$/i
const SIDE_EFFECT = /\.(env|env\.[a-z]+|pem|key|p12|pfx|crt|cer|p8|asc|gpg)$/i

/** Lowercase alphanumeric-fold used for exact anchor equality. */
export function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/** Splits camelCase / PascalCase / snake_case / kebab-case / dotted paths. */
export function decompose(input: string): string[] {
  const out: string[] = []
  for (const raw of input.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue
    const pieces = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/)
      .filter(Boolean)
    out.push(...pieces)
  }
  return out
}

function classify(token: string): MemorySchema.AnchorKind {
  if (HEX.test(token)) return "commit"
  if (SIDE_EFFECT.test(token)) return "config"
  if (EXT.test(token) || PATHY.test(token)) return "path"
  if (UPPER_ERROR.test(token) || ERRORISH.test(token)) return "error"
  if (token.includes("@") || token.includes(".")) return "package"
  if (/^[A-Z]/.test(token)) return "symbol"
  return "identifier"
}

/**
 * Deterministic anchor extraction. Order is first-seen; duplicates collapse by
 * (kind, normalized). Paths also emit their basename and each segment so a
 * query for `session` can find `packages/core/src/session`.
 */
export function extract(text: string): MemorySchema.Anchor[] {
  const seen = new Set<string>()
  const out: MemorySchema.Anchor[] = []

  const push = (kind: MemorySchema.AnchorKind, value: string) => {
    const trimmed = value.trim().replace(/^['"`]|['"`.,;:)\]]+$/g, "")
    if (trimmed.length < MIN_LENGTH || trimmed.length > 200) return
    const normalized = normalize(trimmed)
    if (normalized.length < MIN_LENGTH) return
    if (STOP.has(trimmed.toLowerCase())) return
    const dedupe = `${kind}:${normalized}`
    if (seen.has(dedupe)) return
    if (out.length >= MAX_ANCHORS) return
    seen.add(dedupe)
    out.push({ kind, value: trimmed, normalized })
  }

  // Backticked spans keep commands and identifiers intact as one token.
  const spans = text.match(/`[^`\n]{2,200}`/g) ?? []
  for (const span of spans) {
    const inner = span.slice(1, -1).trim()
    const head = inner.split(/\s+/)[0] ?? ""
    if (COMMAND_HEAD.test(head)) push("command", inner.split(/\s+/).slice(0, 4).join(" "))
    else push(classify(inner), inner)
  }

  const stripped = text.replace(/`[^`\n]{2,200}`/g, " ")
  for (const token of stripped.split(/[\s"'`()[\]{}<>,;:!?|+=\\\n\r\t]+/)) {
    if (!token) continue
    const kind = classify(token)
    push(kind, token)
    if (kind === "path") {
      for (const part of token.split(/[\\/]/)) push("identifier", part)
    } else {
      for (const piece of decompose(token)) push("identifier", piece)
    }
  }

  return out
}

/**
 * Expands a query into FTS-safe terms. Everything outside unicode
 * letters/digits/underscore is a separator, so no FTS5 operator syntax can
 * survive into the MATCH expression.
 */
export function queryTerms(query: string, max: number = 12): string[] {
  const terms = new Set<string>()
  for (const token of query.split(/[^\p{L}\p{N}_]+/u)) {
    if (!token) continue
    const lower = token.toLowerCase()
    if (lower.length < 2 || STOP.has(lower)) continue
    terms.add(lower)
    for (const piece of decompose(token)) {
      const l = piece.toLowerCase()
      if (l.length < 2 || STOP.has(l)) continue
      terms.add(l)
    }
    if (terms.size >= max) break
  }
  return [...terms]
}

const OPERATOR = /^(and|or|not|near)$/i

/**
 * FTS5 MATCH expression: one bare prefix term per query term, implicit AND.
 *
 * `queryTerms` already drops the operator keywords, but the quote is kept as
 * defence in depth: any term that is an FTS5 operator must never reach the
 * MATCH expression bare, regardless of how the term list was produced.
 */
export function matchQuery(query: string): string | undefined {
  const terms = queryTerms(query)
  if (terms.length === 0) return undefined
  return terms.map((term) => (OPERATOR.test(term) ? `"${term}"` : `${term}*`)).join(" ")
}

/** True when no FTS5 operator keyword can appear bare in the MATCH expression. */
export function isOperatorSafe(query: string): boolean {
  const match = matchQuery(query)
  if (!match) return true
  return !match.split(/\s+/).some((token) => OPERATOR.test(token))
}

/** Flattens entry text plus anchors into the FTS `search_text` column. */
export function searchText(input: { title: string; content: string; anchors: MemorySchema.Anchor[] }): string {
  const parts = [input.title, input.content, ...input.anchors.map((a) => a.value)]
  return parts.join("\n").slice(0, 16_000)
}
