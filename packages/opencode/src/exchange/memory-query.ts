export * as ExchangeMemoryQuery from "./memory-query"

/** Conversation-recall scaffolding does not belong in an AND-style FTS query. */
const SCAFFOLD = new Set([
  "where", "leave", "left", "off", "recall", "remember", "previous", "previously",
  "mentioned", "discussed", "discuss", "discussion", "conversation", "conversations",
  "chat", "chats", "earlier", "before", "please", "about", "regarding", "saying",
  "talk", "talked", "happened", "happen", "status", "update", "updates", "latest",
  // Long-form agent handoffs routinely shout these imperatives. They should
  // never displace a real technical symbol from the four-term recall query.
  "proceed", "continue", "continuing", "exhaustively", "comprehensively",
  "critically", "carefully", "investigate", "investigation", "please",
  "toward", "towards", "goal", "goals", "improve", "improving", "work", "working",
  "fix", "fixing",
])
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "was", "were", "are", "have", "has", "had", "did", "does", "do", "we", "our",
  "you", "your", "me", "my", "in", "of", "on", "to", "as", "by", "or", "at",
  "is", "be", "can", "would", "should", "could", "any", "all", "some", "the",
  "what", "why", "how", "which", "who", "whose", "whom",
])

// A single ubiquitous corpus word is unsafe as a fallback for a detailed
// question: it fills the bounded evidence budget with unrelated history.
const GENERIC_FALLBACK = new Set([
  "memory", "memories", "session", "sessions", "project", "projects",
  "search", "query", "queries", "history", "historical", "recall",
  "retrieval", "result", "results", "tool", "tools", "code",
  // Product/runtime names occur in nearly every OpenFork Session, so treating
  // their PascalCase as a rare code identifier is a precision regression.
  "openfork", "opencode", "chatgpt", "github", "runtime", "agent", "agents",
  "core",
])

export interface Plan {
  /** AND query, bounded to four content-bearing lexical terms. */
  readonly focused: string
  /** One deliberately looser bounded query, used ONLY if focused search misses. */
  readonly relaxed?: string
}

export function plan(input: string): Plan {
  // Unlike MemoryAnchors.queryTerms, do NOT split camelCase or compound code
  // identifiers: Session FTS is implicit AND, not an anchor-expanded index.
  // A long prompt may contain the actual API/symbol in the MIDDLE, not just
  // in the first 16 or last 8 tokens. Inspect a bounded span of the original
  // text before picking the identifier (no database work, no regex backtrack).
  const bounded = input.length <= 8192 ? input : input.slice(0, 4096) + " " + input.slice(-4096)
  const raw = (bounded.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 512)
  const unique = [...new Set(raw.map((term) => term.toLowerCase())
    .filter((term) => term.length >= 2 && !STOP.has(term)))]
  // In long, natural-language questions the name of the actual subsystem is
  // often near the END. Keep a bounded tail as well as the question prefix.
  const terms = unique.length > 24
    ? [...unique.slice(0, 16), ...unique.slice(-8)]
    : unique
  const meaningful = terms.filter((term) => !SCAFFOLD.has(term))
  const selected = meaningful.length > 0 ? meaningful : terms
  if (selected.length === 0) return { focused: input }
  const isNumeric = (term: string) => /^\d+$/.test(term)
  const isGenericVersion = (term: string) => /^v\d+$/.test(term)
  const allDistinctive = unique.filter((term) =>
    !SCAFFOLD.has(term) && !GENERIC_FALLBACK.has(term) &&
    !isNumeric(term) && !isGenericVersion(term))
  const allDistinctiveSet = new Set(allDistinctive)
  const distinctive = selected.filter((term) =>
    !GENERIC_FALLBACK.has(term) && !isNumeric(term) && !isGenericVersion(term))
  // A standalone fallback may be a named source identifier, never an ordinary
  // year or version number. Three-letter uppercase acronyms like RRF count.
  const isSourceIdentifier = (term: string) => {
    const value = term.toLowerCase()
    return allDistinctiveSet.has(value) && term.length >= 4 &&
      (/[a-z][A-Z]/.test(term) || /[a-z_][0-9]|[0-9][a-z_]/i.test(term) || term.includes("_"))
  }
  // Prefer structural symbols over all-caps prose. Only short capitals-only
  // sequences count as likely acronyms; PROCEED/EXHAUSTIVELY are not RRF.
  const specific = (raw.find(isSourceIdentifier) ??
    raw.find((term) => term.length >= 3 && term.length <= 5 &&
      /^[A-Z]+$/.test(term) && allDistinctiveSet.has(term.toLowerCase())))?.toLowerCase()
  // A code symbol mentioned in the middle of a detailed prompt should not
  // be AND-ed exclusively with unrelated preamble words. Pair it with the
  // nearest available topic word, falling back to a general content anchor.
  const specificPosition = specific ? allDistinctive.indexOf(specific) : -1
  const contextual = specificPosition >= 0
    ? allDistinctive[specificPosition + 1] ?? allDistinctive[specificPosition - 1]
    : undefined
  const missedMiddle = specific && !selected.includes(specific)
  // Preserve exact dates in focused queries when only one specific topic was
  // provided, but never waste a scarce slot on 2026/10/09 when the question
  // already supplies multiple discriminative words. Reserve one slot for a
  // recognizable identifier even if it occurs at the end of a long question.
  const focusTerms = distinctive.length >= 2
    ? distinctive
    : [...distinctive, ...selected.filter((term) => !distinctive.includes(term))]
  const focused = (specific && !focusTerms.slice(0, 4).includes(specific)
    ? [specific, ...(missedMiddle && contextual ? [contextual] : []),
        ...focusTerms.filter((term) => term !== specific && (!missedMiddle || term !== contextual))]
    : focusTerms).slice(0, 4).join(" ")
  // A generic+single-content fallback is almost always too broad. Even a
  // recognizable but short project/acronym name (ArcFit, SVG, RRF) frequently
  // appears in many unrelated conversations: preserve one topical qualifier
  // when the user supplied one. Exception: a long exact code symbol is useful
  // alone (e.g. useGroupBoundsNormalization).
  const natural = distinctive.length >= 2 ? distinctive.slice(0, 2).join(" ") : undefined
  const qualifier = specific && (missedMiddle ? contextual : distinctive.find((term) => term !== specific))
  const fallback = specific
    ? qualifier && specific.length < 16 && !specific.includes("_")
      ? `${specific} ${qualifier}`
      : specific
    : natural
  const relaxed = fallback && focused !== fallback ? fallback : undefined
  return { focused, ...(relaxed ? { relaxed } : {}) }
}