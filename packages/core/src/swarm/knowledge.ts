export * as SwarmKnowledge from "./knowledge"

import { Swarm } from "@opencode-ai/schema/swarm"

/**
 * Why a Blackboard entry was considered relevant to one task handoff.
 *
 * `task` — the entry is filed under the receiving task.
 * `related` — the entry is filed under a task the caller declared related
 * (for example a DAG dependency) and not under the receiving task.
 * `swarm` — the entry is not filed under any task and therefore applies to
 * every task in the Swarm.
 *
 * Entries filed under some *other* undeclared task are not candidates at all:
 * task-scoped knowledge is not swarm-wide, and silently widening it would put
 * unrelated work into a handoff.
 */
export type KnowledgeScope = "task" | "related" | "swarm"

export interface KnowledgeLimits {
  readonly maxEntries: number
  readonly maxBytes: number
}

/**
 * Handoff defaults are deliberately small. This projection feeds one bounded
 * assignment envelope, so its cost must be independent of how much knowledge
 * the Swarm has accumulated.
 */
export const DEFAULT_LIMITS = {
  maxEntries: 12,
  maxBytes: 4_096,
} as const satisfies KnowledgeLimits

/** Hard ceiling for caller-supplied limits; a caller cannot uncap the read. */
export const MAX_LIMITS = {
  maxEntries: 50,
  maxBytes: 32_768,
} as const satisfies KnowledgeLimits

/**
 * Hard ceiling on rows hydrated from storage before selection. The digest is
 * bounded in both the number of rows it may inspect and the bytes it returns.
 *
 * This must be enforced as a SQL LIMIT by the retrieval path, not as an
 * in-memory slice after hydration: a cap applied after the rows are already
 * materialized bounds the result but not the read.
 */
export const MAX_CANDIDATES = 500

/**
 * Hard ceiling on caller-declared related tasks.
 *
 * Related task ids become an `IN (...)` predicate. An unbounded caller-supplied
 * list makes both the statement text and the planner's work scale with caller
 * input, so the read truncates deterministically and reports what it dropped
 * instead of silently returning a different knowledge set than requested.
 */
export const MAX_RELATED_TASKS = 16

export interface RelatedTaskSelection {
  /** Deduplicated related tasks, never including the receiving task. */
  readonly tasks: ReadonlyArray<Swarm.TaskID>
  /** Caller-declared related tasks discarded by {@link MAX_RELATED_TASKS}. */
  readonly dropped: number
}

/**
 * Deduplicate and bound a caller-declared related-task set.
 *
 * The receiving task is never related to itself. Truncation keeps the caller's
 * declared order (after first-seen dedupe) so two callers declaring the same
 * set always observe the same digest.
 */
export function selectRelatedTasks(
  receiving: Swarm.TaskID | undefined,
  related: ReadonlyArray<Swarm.TaskID> | undefined,
): RelatedTaskSelection {
  const seen = new Set<Swarm.TaskID>()
  for (const id of related ?? []) {
    if (id === receiving) continue
    seen.add(id)
  }
  const ordered = [...seen]
  return {
    tasks: ordered.slice(0, MAX_RELATED_TASKS),
    dropped: Math.max(0, ordered.length - MAX_RELATED_TASKS),
  }
}

export interface KnowledgeCandidate {
  readonly scope: KnowledgeScope
  /** Durable `time_updated` of the row, as epoch milliseconds. */
  readonly updatedAt: number
  readonly entry: Swarm.BlackboardEntry
}

/**
 * One admitted Blackboard entry plus the provenance a handoff needs to treat
 * it as shared working knowledge rather than as instruction authority.
 *
 * `value` is peer-authored collaboration data. A consumer that renders it must
 * fence it exactly like a peer message body; this projection deliberately adds
 * no host directive and no trust claim of its own.
 */
export interface KnowledgeEntry {
  readonly scope: KnowledgeScope
  readonly key: string
  readonly version: number
  readonly authorMemberID: Swarm.MemberID
  readonly taskID?: Swarm.TaskID
  readonly contentType: string
  readonly updatedAt: number
  readonly bytes: number
  readonly value: Swarm.BlackboardEntry["value"]
}

export interface KnowledgeDigest {
  /** Admitted entries, always a prefix of the deterministically ordered candidates. */
  readonly entries: ReadonlyArray<KnowledgeEntry>
  /** Total admitted bytes; never exceeds `limits.maxBytes`. */
  readonly bytes: number
  /** Candidates supplied to selection after the storage read cap. */
  readonly scanned: number
  /**
   * Candidates not admitted: entries larger than the whole byte budget plus
   * entries beyond the entry/byte caps. Surfaced so a caller can report
   * incomplete knowledge instead of silently presenting a truncated digest.
   */
  readonly omitted: number
  /**
   * The storage read filled its row cap, so at least one matching entry was
   * never hydrated and therefore never appears in `scanned`.
   *
   * Reported as a flag rather than a count because the retrieval path cannot
   * know how many rows it withheld without a second unbounded read. Reporting a
   * fabricated number would be worse than reporting the uncertainty.
   */
  readonly storageTruncated: boolean
  /** Caller-declared related tasks refused by {@link MAX_RELATED_TASKS}. */
  readonly droppedRelatedTasks: number
  /**
   * True whenever this digest is not a complete view of the knowledge that was
   * requested: entry/byte omission, storage row-cap truncation, or dropped
   * related tasks. A caller that renders a handoff must be able to say so.
   */
  readonly truncated: boolean
  readonly limits: KnowledgeLimits
}

const encoder = new TextEncoder()

const SCOPE_RANK: Record<KnowledgeScope, number> = {
  task: 0,
  related: 1,
  swarm: 2,
}

/**
 * The exact record a JSON consumer receives. One builder so the measured cost
 * and the emitted record can never drift apart.
 */
function projectEntry(candidate: KnowledgeCandidate, bytes: number): KnowledgeEntry {
  const entry = candidate.entry
  return {
    scope: candidate.scope,
    key: entry.key,
    version: entry.version,
    authorMemberID: entry.authorMemberID,
    ...(entry.taskID === undefined ? {} : { taskID: entry.taskID }),
    contentType: entry.contentType,
    updatedAt: candidate.updatedAt,
    bytes,
    value: entry.value,
  }
}

/**
 * Cost of one candidate, measured as the UTF-8 bytes of the exact projected
 * record. Measuring the projection rather than the stored value keeps
 * provenance — and the candidate's real scope, not an assumed one — from
 * escaping the budget.
 *
 * `bytes` is charged at zero width because it is this very measurement, so a
 * re-serialized record differs only by the digits of a small integer. The
 * budget is therefore a conservative lower bound, never an over-estimate.
 */
export function entryBytes(candidate: KnowledgeCandidate) {
  return encoder.encode(JSON.stringify(projectEntry(candidate, 0))).byteLength
}

function clamp(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}

/** Clamp caller limits into the hard ceiling. Unusable input falls back to defaults. */
export function resolveLimits(limits?: Partial<KnowledgeLimits>): KnowledgeLimits {
  return {
    maxEntries: clamp(limits?.maxEntries, DEFAULT_LIMITS.maxEntries, MAX_LIMITS.maxEntries),
    maxBytes: clamp(limits?.maxBytes, DEFAULT_LIMITS.maxBytes, MAX_LIMITS.maxBytes),
  }
}

/**
 * Total order over candidates: relevance scope first, then most recently
 * updated, then key ascending. Recency must not outrank scope, otherwise a
 * swarm-wide note could displace task-filed knowledge.
 */
function compare(a: KnowledgeCandidate, b: KnowledgeCandidate) {
  const rank = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
  if (rank !== 0) return rank
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.entry.key === b.entry.key) return 0
  return a.entry.key < b.entry.key ? -1 : 1
}

/**
 * Deterministic bounded selection.
 *
 * Admission is whole-entry and prefix-preserving: entries are admitted in
 * order and selection stops at the first entry that does not fit. A lower
 * priority entry can therefore never displace a higher priority one, and two
 * callers given the same candidates always observe the same digest.
 */
export function digest(input: {
  readonly candidates: ReadonlyArray<KnowledgeCandidate>
  readonly limits?: Partial<KnowledgeLimits>
  /** Set when the storage read filled its SQL row cap before hydration. */
  readonly storageTruncated?: boolean
  /** Caller-declared related tasks the read refused to expand. */
  readonly droppedRelatedTasks?: number
}): KnowledgeDigest {
  const limits = resolveLimits(input.limits)
  const storageTruncated = input.storageTruncated ?? false
  const droppedRelatedTasks = input.droppedRelatedTasks ?? 0
  const eligible: Array<KnowledgeCandidate & { readonly bytes: number }> = []
  let ineligible = 0
  for (const candidate of input.candidates) {
    const bytes = entryBytes(candidate)
    if (bytes > limits.maxBytes) {
      ineligible += 1
      continue
    }
    eligible.push({ ...candidate, bytes })
  }
  eligible.sort(compare)

  const entries: Array<KnowledgeEntry> = []
  let bytes = 0
  for (const candidate of eligible) {
    if (entries.length >= limits.maxEntries) break
    if (bytes + candidate.bytes > limits.maxBytes) break
    entries.push(projectEntry(candidate, candidate.bytes))
    bytes += candidate.bytes
  }

  const omitted = ineligible + (eligible.length - entries.length)
  return {
    entries,
    bytes,
    scanned: input.candidates.length,
    omitted,
    storageTruncated,
    droppedRelatedTasks,
    truncated: omitted > 0 || storageTruncated || droppedRelatedTasks > 0,
    limits,
  }
}
