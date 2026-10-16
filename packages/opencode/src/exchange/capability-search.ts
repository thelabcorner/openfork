/**
 * Bounded lexical, action-aware OXP discovery. No embeddings, model call,
 * workspace initialization, user history, or permission inference.
 *
 * Context economics: index only immutable catalog summaries and reviewed
 * action names. Never materialize the (potentially huge) JSON input schemas.
 * Sorting affects presentation, not the principal's authority to call tools.
 */
export interface SearchableCapability {
  readonly id: string
  readonly description: string
  readonly focusActions?: Readonly<Record<string, unknown>>
  /** Explicit foreign-MCP ownership suppresses OpenFork-only search affordances. */
  readonly namespace?: "openfork" | "mcp"
}

export interface RankedResult<T> {
  readonly item: T
  readonly score: number
  readonly matched: number
}

// Same externally admitted size as Exchange Code's search parameter. Only the
// first 12 informative terms contribute; the caller's original query still
// keys cursor identity and authorizes no execution.
const MAX_QUERY_CHARS = 4_096
const MAX_QUERY_TERMS = 12
// Strip request scaffolding and ubiquitous permission prose so a distinctive
// operation ("unpack tarball") is not outranked by generic "approved root".
// This is retrieval hygiene only; execution still checks every authority.
const STOP = new Set([
  "a", "all", "an", "and", "any", "approved", "are", "can", "could", "do",
  "for", "how", "i", "in", "is", "me", "my", "of", "on", "or", "please",
  "that", "the", "these", "this", "those", "to", "use", "using", "what",
  "where", "which", "with", "you",
])
const ALIASES: Readonly<Record<string, string>> = {
  // Authored search vocabulary is only a discovery hint, never an executable
  // operation or root/session permission grant. The action map, if present,
  // comes from the explicit reviewed capability owner.
  openfork_swarm: "members workers agents tasks collaborative team coordinator orchestration batch parallel staged delegate recover receipts",
  openfork_worker: "agent workers delegate spawn launch batch multiple parallel continue stop wait results session blocked waiting",
  json: "json jsonc jsonl bson json patch patches query validate schema parse compare logs structures",
  patch: "patch patches hunks diffs conflict multi file batch apply partial resume",
  edit: "text substring find replace edit file",
  write: "create new file overwrite replace content generate readme draft scaffold initialize",
  read: "read files content text inspect tail last first lines line document",
  find: "search grep glob regex files names text locate filename filenames pattern patterns todo fixme annotations markers comments",
  symbols: "symbols declarations references usages usage sites call sites definition outline tree sitter function functions method methods class classes called callsite caller callers invokes invoked implementations callsites",
  lsp: "diagnostics language server references definition hover",
  project: "project workspace workspaces stack scripts runtime versions toolchain packages monorepo repo repository overview layout dependency dependencies directory architecture",
  process: "run command shell terminal spawn stdout stderr log processes running printed printing output error errors",
  test: "tests suite runner jest bun vite vitest filter rerun repeat failing fail failures broken single case",
  typecheck: "typescript typecheck diagnostics errors",
  browser: "navigate click page screenshot capture tab resize scroll",
  schedule: "schedule scheduled automations recurring monitor timer jobs job remind reminders every morning weekly monday",
  "schedule.create": "schedule create recurring automation timer reminder",
  "openfork_session.checkpoint": "checkpoint restore session rollback undo",
  memory: "memory recall remember forget lessons history session prior previous earlier decisions decided coding past preferences",
  "file.transfer": "upload transfer attachments import files",
  models: "model catalog variants pricing context provider",
  git: "git status diff commit commits branch history stage staged unstaged uncommitted modified changes checkout working tree worktree files release",
  refactor: "refactor rename renaming variable safely symbols codebase references project wide",
  archive: "archive zip tar tarball unpack extract compressed decompress entries",
  sympy: "sympy symbolic symbolically polynomial differentiate integrate antiderivative integration primitive derivative equation algebra",
  web: "web internet online search fetch external website page documentation",
}

/** Singularize only simple plurals; never turn 'status' into 'statu'. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return token.slice(0, -3) + "y"
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us"))
    return token.slice(0, -1)
  return token
}

function tokenize(source: string): string[] {
  return (source
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [])
    .map(stem)
    .filter((token) => token.length > 0 && !STOP.has(token))
}

/**
 * Strip a bounded set of leading politeness scaffolds for *ranking only*.
 * This is not an instruction interpreter: original query strings still own
 * pagination identity and remain available to the transport for auditing.
 */
function intentText(source: string): string {
  let query = source.slice(0, MAX_QUERY_CHARS).trim()
  for (let i = 0; i < 3; i++) {
    const next = query.replace(/^(?:please,?|could you|if possible,?|i['’]d like you to)\s+/i, "").trimStart()
    if (next === query) break
    query = next
  }
  return query
}

function terms(query: string): string[] {
  return [...new Set(tokenize(intentText(query)))].slice(0, MAX_QUERY_TERMS)
}

/**
 * Recognize *unambiguous* explanation/creative-writing requests that mention
 * operation vocabulary but do not request workspace execution. This is a
 * cheap discovery abstention cue, NOT an LLM intent classifier or permission
 * check. Deliberately leave mixed and imperative requests to the lexical
 * ranker; a false abstention can be worse than a low-confidence suggestion.
 */
function nonOperationalRequest(source: string): boolean {
  const q = intentText(source).toLowerCase().replace(/\s+/g, " ")
  if (/^(?:(?:please\s+)?(?:write|compose|tell me|create|generate)\s+(?:(?:me|a|an|the|some|funny|fictional|children'?s|motivational)\s+){0,5}(?:story|poem|speech|paragraph|biography)\b|a children'?s story\b)/.test(q)) return true
  // An explicit inquiry about the tool/capability is itself a discoverable
  // operation. Do not confuse that with an unrelated concept explanation.
  if (/\b(?:tool|capability|operations?)\b/.test(q) &&
    !/\b(?:story|poem|speech|fiction)\b/.test(q)) return false
  // High-specificity conceptual/educational cues outrank task vocabulary.
  // A question word alone is not evidence: "What are my current workers?"
  // and "Explain these diagnostics" must remain actionable.
  if (/\bdifferences? between\b/.test(q) &&
    /\b(?:these|two|my|our)\s+(?:json|jsonc|jsonl|bson|files?|logs?|documents?)\b/.test(q)) return false
  if (/\b(?:conceptually|for beginners|plain english|someone learning|stand for|purpose of|benefits of|differences? between|history of|best practices)\b/.test(q)) return true
  if (/^(?:explain|teach me|how (?:do|does))\b.*\b(?:how|why)\b.*\b(?:work|works|render)\b/.test(q)) return true
  if (/^(?:explain|teach me)\b.*\b(?:work|works)\s*[?.!]*$/.test(q)) return true
  if (/^how\s+(?:do|can)\s+i\s+(?:list|run|find|search|rename|inspect|open|check|show|export|read|write|edit|apply|create|restore)\b/.test(q)) return false
  // Concrete deictics, recent state, file extensions and explicit code
  // operations signal a real inspection even when phrased interrogatively.
  // Avoid a broad "contains my" test for unrelated creative prose by keeping
  // this below the high-confidence conceptual and creative-writing checks.
  if (/\b(?:my|our|this|these|currently|current|latest|last|active|running|existing|attached|selected|unstaged|uncommitted|new)\b|\b(?:right now|at the moment)\b/.test(q) ||
    /\b(?:two|these)\s+(?:json|jsonc|jsonl|bson)\b/.test(q) ||
    /\b(?:skill\.md|readme\.md|\.test\.ts|\bselect\s+statement\b)\b/.test(q)) return false
  // Educational definitions without an artifact reference should abstain.
  return /^(?:what\s+(?:is|are|does|do)\b|what'?s\s+|why\s+|how\s+(?:do|does|is|are)\b|explain\b|teach\s+me\b|describe\b|summarize\s+the\s+history\b|compare\b)/.test(q)
}

function containsTerm(haystack: ReadonlySet<string>, token: string): boolean {
  if (haystack.has(token)) return true
  // Constrain typos and inflections to nontrivial terms. No fuzzy matching of
  // two-character terms: this is not a broad free-form substring search.
  if (token.length >= 5) for (const word of haystack)
    if (word.length >= 5 && (word.startsWith(token) || token.startsWith(word))) return true
  return false
}

type Index = {
  readonly id: string
  readonly description: string
  readonly actionNames: string
  readonly idWords: ReadonlySet<string>
  readonly descriptionWords: ReadonlySet<string>
  readonly actionWords: ReadonlySet<string>
}
// Weak identity caching only: no unbounded global table retaining untrusted
// remote MCP descriptions. Source catalog Definitions have stable identities,
// while ephemeral Code wrappers are still safely garbage-collected. Compare
// exact index inputs so in-place edits never leave stale ranking semantics.
const indexCache = new WeakMap<SearchableCapability, Index>()
const aliasTokens = new Map(Object.entries(ALIASES).map(([id, words]) => [id, new Set(tokenize(words))]))
// Domain owner says public model metadata cannot read a user's configured
// quota. An exclusion prevents the same negative description ("quota remains
// host-private") from becoming a misleading positive search signal.
const UNSUPPORTED_TERMS: Readonly<Record<string, { readonly terms: ReadonlySet<string>; readonly sourceMarker: string }>> = {
  // Scope to this *specific* OpenFork public models descriptor, not an
  // unrelated external MCP capability that happens to share the name.
  models: {
    terms: new Set(["quota"]),
    sourceMarker: "quota and global accounting remain host-private",
  },
}
const GENERIC_VERB_IDS = new Set(["write", "read", "edit", "find", "test"])

function index(item: SearchableCapability): Index {
  const actionNames = Object.keys(item.focusActions ?? {}).join(" ")
  const previous = indexCache.get(item)
  if (previous && previous.id === item.id && previous.description === item.description && previous.actionNames === actionNames)
    return previous
  const built: Index = {
    id: item.id,
    description: item.description,
    actionNames,
    idWords: new Set(tokenize(item.id)),
    descriptionWords: new Set(tokenize(item.description)),
    actionWords: new Set(tokenize(actionNames)),
  }
  indexCache.set(item, built)
  return built
}

function score(item: SearchableCapability, query: readonly string[]): RankedResult<SearchableCapability> {
  const indexed = index(item)
  // A foreign tool reusing an OpenFork capability name does not inherit the
  // OpenFork owner's claimed actions or task language.
  const synonyms = item.namespace === "mcp" ? undefined : aliasTokens.get(item.id)
  let matched = 0
  let points = 0
  for (const token of query) {
    let relevance = 0
    if (containsTerm(indexed.idWords, token)) relevance = 12
    // An explicitly reviewed operation is as strong a signal as a tool name:
    // 'batch workers' should find Swarm.member.batch, not only Worker.list.
    else if (containsTerm(indexed.actionWords, token)) relevance = 12
    else if (containsTerm(indexed.descriptionWords, token)) relevance = 5
    else if (synonyms && containsTerm(synonyms, token)) relevance = 3
    if (relevance > 0) {
      matched++
      points += relevance
    }
  }
  // Correct multi-term intent must dominate a single high-weight ID match.
  return { item, score: points + matched * matched * 16, matched }
}

/**
 * Ranked recall with confidence-gated fallback. Requires at least two term
 * matches for multi-term queries where possible; if none match two, return
 * partial candidates instead of the legacy empty list.
 *
 * Never modify normal empty-query catalog ordering, which is part of the
 * legacy discovery contract. No hard top-N: explicit list remains complete
 * within the catalog's existing bound.
 */
export function rankCapabilities<T extends SearchableCapability>(items: readonly T[], query?: string): T[] {
  const q = terms(query ?? "")
  if (q.length === 0) {
    // An explicit all-stopword or punctuation-only search is NOT a request to
    // dump the entire catalog. Only an omitted/blank query opts into listing
    // everything. This bounds prompt bloat for malformed or chatty queries.
    if (query?.trim()) return []
    return [...items].sort((a, b) => a.id.localeCompare(b.id))
  }
  if (query && nonOperationalRequest(query)) return []
  const ranked = items
    .filter((item) => {
      const excluded = item.namespace === "mcp" ? undefined : UNSUPPORTED_TERMS[item.id]
      return !excluded || !item.description.toLowerCase().includes(excluded.sourceMarker) ||
        !q.some((term) => excluded.terms.has(term))
    })
    .map((item) => score(item, q))
    .filter((result) => result.matched > 0)
  const hasStrong = ranked.some((result) => result.matched >= Math.min(q.length, 2))
  // Long conversational searches with one matching generic verb are not an
  // instruction to perform filesystem mutations. Abstain when no candidate
  // has two independent signals and no distinctive tool identity was named.
  // Short 1-3 term searches retain the previous partial-recall behavior.
  if (q.length >= 4 && !hasStrong && !ranked.some((result) =>
    !GENERIC_VERB_IDS.has(result.item.id) && q.includes(stem(result.item.id.toLowerCase()))
  )) return []
  const chosen = hasStrong
    ? ranked.filter((result) => result.matched >= Math.min(q.length, 2))
    : ranked
  return chosen
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.item.id.localeCompare(b.item.id))
    .map((result) => result.item as T)
}

export * as OxpCapabilitySearch from "./capability-search"
