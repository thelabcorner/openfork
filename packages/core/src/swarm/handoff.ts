import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import type { DatabaseShape } from "../database/database"
import {
  byteLength,
  clampText,
  TASK_RUN_RESULT_SUMMARY_MAX_BYTES,
} from "./bounds"
export { byteLength, clampText } from "./bounds"
import {
  SwarmBlackboardTable,
  SwarmDeliverableTable,
  SwarmTaskDependencyTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"

type Db = DatabaseShape

/**
 * Bounded predecessor knowledge handoff (ledger P4).
 *
 * The successor of a DAG dependency needs what its predecessor *produced*, not
 * what its predecessor *said*. Predecessor Session history is therefore never
 * read here. Every dimension that could otherwise grow with predecessor
 * activity — dependency degree, deliverable count, ref/file count, summary
 * length, shared-state value size, and total handoff size — is capped by
 * `HANDOFF_LIMITS`, so a successor assignment costs the same regardless of how
 * long the predecessor ran or how much it published.
 *
 * Trust: every projected value below is member/model-authored collaboration
 * data. The projection carries it as opaque text; only the renderer decides how
 * it is fenced. No field in this projection is instruction authority.
 */
export const HANDOFF_LIMITS = {
  /** Predecessor tasks included in one handoff. */
  predecessors: 8,
  /** Deliverables projected per predecessor. */
  deliverables: 4,
  /** Successful exact-run result bytes kept per predecessor. */
  resultSummaryBytes: 1024,
  /** Deliverable summary bytes kept per predecessor (concatenated, in order). */
  summaryBytes: 512,
  /** Ref/file entries projected per deliverable. */
  refs: 6,
  files: 6,
  /** Bytes kept per single ref/file entry. */
  pathBytes: 200,
  /** Task-tagged shared-state entries projected per predecessor. */
  sharedEntries: 4,
  /** Bytes kept per shared-state key / serialized value. */
  sharedKeyBytes: 120,
  sharedValueBytes: 256,
  /** Bytes allowed for one fully projected predecessor. */
  predecessorBytes: 2048,
  /** Bytes allowed for the whole handoff projection. */
  totalBytes: 16 * 1024,
} as const

/**
 * Read-side payload clamps applied in SQL, before a row leaves SQLite.
 *
 * Durable `summary` / `refs` / `files` / Blackboard `value` columns have no
 * write-side size limit today (bounded publication is owned by the
 * shared-state/deliverable producers, not by this reader). Without these
 * clamps a single oversized row could still be transferred whole and then
 * truncated in memory, which is exactly the unbounded read this projection
 * exists to prevent. Each clamp is generous relative to `HANDOFF_LIMITS`; it
 * exists to bound transport, not to define the projection.
 */
export const HANDOFF_READ_CLAMPS = {
  deliverableSummary: 4096,
  deliverableList: 4096,
  sharedKey: 512,
  sharedValue: 2048,
  failureDetail: 4096,
  resultSummary: TASK_RUN_RESULT_SUMMARY_MAX_BYTES,
  taskTitle: 4096,
} as const

export interface HandoffLimits {
  readonly predecessors: number
  readonly deliverables: number
  readonly resultSummaryBytes: number
  readonly summaryBytes: number
  readonly refs: number
  readonly files: number
  readonly pathBytes: number
  readonly sharedEntries: number
  readonly sharedKeyBytes: number
  readonly sharedValueBytes: number
  readonly predecessorBytes: number
  readonly totalBytes: number
}

/**
 * Bounded projection of an unbounded list of collaborator-authored strings.
 * `dropped` is reported so the host can be honest about omission instead of
 * silently presenting a partial list as complete.
 */
export function boundList(
  items: readonly string[],
  limit: { readonly maxItems: number; readonly itemBytes: number; readonly totalBytes: number },
): { readonly items: readonly string[]; readonly dropped: number; readonly bytes: number } {
  const kept: string[] = []
  let bytes = 0
  for (const item of items) {
    const value = clampText(item, limit.itemBytes)
    const size = byteLength(value)
    if (kept.length >= limit.maxItems || bytes + size > limit.totalBytes) continue
    kept.push(value)
    bytes += size
  }
  return { items: kept, dropped: Math.max(0, items.length - kept.length), bytes }
}

/** Deterministic, bounded textual form of an arbitrary shared-state JSON value. */
export function sharedValueText(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? "" : encoded
  } catch {
    return "[unserializable shared value]"
  }
}

/** Tolerant parse for SQL-clamped JSON list columns. */
export function parseBoundedList(text: string) {
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return { items: [] as string[], truncated: true }
    return { items: parsed.filter((item): item is string => typeof item === "string"), truncated: false }
  } catch {
    return { items: [] as string[], truncated: true }
  }
}

export interface HandoffPredecessorRow {
  readonly taskID: Swarm.TaskID
  readonly requirement: Swarm.DependencyRequirement
  readonly title: string
  readonly status: Swarm.TaskStatus
  readonly completed: boolean
  /** Host-derived terminal description, e.g. `completed` or `failed:semantic — …`. */
  readonly outcome: string
  readonly semanticRetryCount: number
  /** Exact member that authored the latest successful TaskRun result. */
  readonly resultMemberID?: Swarm.MemberID
  /** Bounded durable result from the latest successful TaskRun, if one exists. */
  readonly resultSummary?: string
}

export interface HandoffDeliverableRow {
  readonly id: Swarm.DeliverableID
  readonly taskID: Swarm.TaskID
  readonly memberID: Swarm.MemberID
  readonly summary: string
  readonly refs: readonly string[]
  readonly files: readonly string[]
  readonly verdict: Swarm.DeliverableVerdict | undefined
  /** True when a read-side clamp already truncated this row's list column. */
  readonly listsClamped: boolean
}

export interface HandoffSharedRow {
  readonly taskID: Swarm.TaskID
  readonly key: string
  readonly value: string
  readonly contentType: string
  readonly version: number
  readonly authorMemberID: Swarm.MemberID
  readonly valueClamped: boolean
}

export interface HandoffDeliverable {
  readonly id: Swarm.DeliverableID
  readonly memberID: Swarm.MemberID
  readonly verdict: Swarm.DeliverableVerdict | undefined
  readonly refs: readonly string[]
  readonly files: readonly string[]
  /** "refs/files are references, not durable artifact bytes" provenance. */
  readonly refsAreReferences: true
  readonly clamped: boolean
}

export interface HandoffSharedEntry {
  readonly key: string
  readonly contentType: string
  readonly version: number
  readonly authorMemberID: Swarm.MemberID
  readonly value: string
}

export interface HandoffPredecessor {
  readonly taskID: Swarm.TaskID
  readonly requirement: Swarm.DependencyRequirement
  readonly title: string
  readonly status: Swarm.TaskStatus
  readonly completed: boolean
  readonly outcome: string
  readonly semanticRetryCount: number
  /** Exact member that authored resultSummary; absent when no durable successful result exists. */
  readonly resultMemberID: Swarm.MemberID | undefined
  /** Successful exact-run result from swarm_member.done/task.settle. */
  readonly resultSummary: string
  /** Bounded concatenation of separately published deliverable summaries. */
  readonly summary: string
  readonly deliverables: readonly HandoffDeliverable[]
  readonly shared: readonly HandoffSharedEntry[]
  readonly droppedDeliverables: number
  readonly droppedSharedEntries: number
}

export interface SwarmHandoff {
  readonly predecessors: readonly HandoffPredecessor[]
  /** Predecessor edges that existed but did not fit the bounded projection. */
  readonly droppedPredecessors: number
  /** True whenever any dimension was omitted, so the host never implies completeness. */
  readonly truncated: boolean
  readonly totalBytes: number
}

export interface HandoffLatestRun {
  readonly status: Swarm.TaskRunStatus
  readonly memberID?: Swarm.MemberID
  readonly failureKind: Swarm.TaskFailureKind | null
  readonly failureDetail: string | null
  readonly failureLength: number | null
  readonly resultSummary?: string | null
}

/**
 * Host-derived terminal description of one prerequisite.
 *
 * `require_terminal` deliberately unblocks a successor after a *failed*
 * predecessor, so `status: failed` alone would hand the successor a dead end.
 * The durable run trace already carries the semantic failure kind and detail at
 * the moment it is settled; the successor needs exactly that bounded reason.
 */
export function outcomeOf(
  status: Swarm.TaskStatus,
  run: HandoffLatestRun | undefined,
  limits: Pick<HandoffLimits, "summaryBytes">,
) {
  if (status === "completed") return "completed"
  if (status === "cancelled") return "cancelled"
  if (status !== "failed") return status
  const kind = run?.failureKind
  if (!kind) return "failed"
  const detail = run?.failureDetail?.trim()
  if (!detail) return `failed:${kind}`
  return `failed:${kind} — ${clampText(detail, limits.summaryBytes)}`
}

function projectDeliverables(
  rows: readonly HandoffDeliverableRow[],
  limits: HandoffLimits,
): Pick<HandoffPredecessor, "summary" | "deliverables" | "droppedDeliverables"> {
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const selected = ordered.slice(0, limits.deliverables)
  const summaries: string[] = []
  let summaryBytes = 0
  for (const row of selected) {
    if (summaryBytes >= limits.summaryBytes) break
    const text = row.summary.trim()
    if (!text) continue
    const value = clampText(text, limits.summaryBytes - summaryBytes)
    summaries.push(value)
    summaryBytes += byteLength(value) + 1
  }
  const deliverables = selected.map((row) => {
    const refs = boundList(row.refs, {
      maxItems: limits.refs,
      itemBytes: limits.pathBytes,
      totalBytes: limits.pathBytes * limits.refs,
    })
    const files = boundList(row.files, {
      maxItems: limits.files,
      itemBytes: limits.pathBytes,
      totalBytes: limits.pathBytes * limits.files,
    })
    return {
      id: row.id,
      memberID: row.memberID,
      verdict: row.verdict,
      refs: refs.items,
      files: files.items,
      refsAreReferences: true,
      clamped: row.listsClamped || refs.dropped > 0 || files.dropped > 0,
    } as const
  })
  return {
    summary: summaries.join("\n"),
    deliverables,
    droppedDeliverables: Math.max(0, ordered.length - selected.length),
  }
}

function projectShared(rows: readonly HandoffSharedRow[], limits: HandoffLimits) {
  const ordered = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const selected = ordered.slice(0, limits.sharedEntries)
  const entries = selected.map((row) => ({
    key: clampText(row.key, limits.sharedKeyBytes),
    contentType: clampText(row.contentType, limits.sharedKeyBytes),
    version: row.version,
    authorMemberID: row.authorMemberID,
    value: clampText(row.value, limits.sharedValueBytes),
  }))
  return {
    shared: entries,
    droppedSharedEntries:
      Math.max(0, ordered.length - selected.length) +
      (ordered.some((row) => row.valueClamped) || selected.length < ordered.length ? 1 : 0),
  }
}

/**
 * Pure, deterministic projection from already-bounded durable rows to the
 * handoff contract. Kept free of SQL so every bound is directly testable and
 * so the same shaping cannot drift between the database read and the renderer.
 */
export function buildHandoff(
  input: {
    readonly predecessors: readonly HandoffPredecessorRow[]
    readonly deliverables: readonly HandoffDeliverableRow[]
    readonly shared: readonly HandoffSharedRow[]
    readonly droppedPredecessors?: number
  },
  limits: HandoffLimits = HANDOFF_LIMITS,
): SwarmHandoff {
  const orderedPredecessors = [...input.predecessors].sort((a, b) =>
    a.taskID < b.taskID ? -1 : a.taskID > b.taskID ? 1 : 0,
  )
  const selected = orderedPredecessors.slice(0, limits.predecessors)
  let droppedPredecessors = Math.max(
    0,
    (input.droppedPredecessors ?? 0) + (orderedPredecessors.length - selected.length),
  )

  const deliverablesByTask = new Map<Swarm.TaskID, HandoffDeliverableRow[]>()
  for (const row of input.deliverables) {
    const bucket = deliverablesByTask.get(row.taskID)
    if (bucket === undefined) deliverablesByTask.set(row.taskID, [row])
    else bucket.push(row)
  }
  const sharedByTask = new Map<Swarm.TaskID, HandoffSharedRow[]>()
  for (const row of input.shared) {
    const bucket = sharedByTask.get(row.taskID)
    if (bucket === undefined) sharedByTask.set(row.taskID, [row])
    else bucket.push(row)
  }

  const projected: HandoffPredecessor[] = []
  let truncated = droppedPredecessors > 0
  for (const predecessor of selected) {
    const deliverables = projectDeliverables(deliverablesByTask.get(predecessor.taskID) ?? [], limits)
    const shared = projectShared(sharedByTask.get(predecessor.taskID) ?? [], limits)
    const rawResultSummary = predecessor.resultSummary?.trim() ?? ""
    const resultSummary = clampText(rawResultSummary, limits.resultSummaryBytes)
    if (byteLength(rawResultSummary) > limits.resultSummaryBytes) truncated = true
    const candidate: HandoffPredecessor = {
      taskID: predecessor.taskID,
      requirement: predecessor.requirement,
      title: clampText(predecessor.title, limits.summaryBytes),
      status: predecessor.status,
      completed: predecessor.completed,
      outcome: predecessor.outcome,
      semanticRetryCount: predecessor.semanticRetryCount,
      resultMemberID: predecessor.resultMemberID,
      resultSummary,
      summary: deliverables.summary,
      deliverables: deliverables.deliverables,
      shared: shared.shared,
      droppedDeliverables: deliverables.droppedDeliverables,
      droppedSharedEntries: shared.droppedSharedEntries,
    }
    if (byteLength(JSON.stringify(candidate)) > limits.predecessorBytes) {
      // Per-predecessor overflow degrades to identity-plus-truncated-summary
      // rather than letting one predecessor consume the whole budget.
      const reduced: HandoffPredecessor = {
        taskID: candidate.taskID,
        requirement: candidate.requirement,
        title: clampText(candidate.title, 120),
        status: candidate.status,
        completed: candidate.completed,
        outcome: candidate.outcome,
        semanticRetryCount: candidate.semanticRetryCount,
        resultMemberID: candidate.resultMemberID,
        resultSummary: clampText(candidate.resultSummary, Math.floor(limits.resultSummaryBytes / 2)),
        summary: clampText(candidate.summary, Math.floor(limits.summaryBytes / 2)),
        deliverables: [],
        shared: [],
        droppedDeliverables: candidate.droppedDeliverables + candidate.deliverables.length,
        droppedSharedEntries: candidate.droppedSharedEntries + candidate.shared.length,
      }
      truncated = true
      if (byteLength(JSON.stringify(reduced)) > limits.predecessorBytes) {
        droppedPredecessors++
        continue
      }
      projected.push(reduced)
      continue
    }
    projected.push(candidate)
  }

  let totalBytes = byteLength(JSON.stringify(projected))
  while (projected.length > 0 && totalBytes > limits.totalBytes) {
    const dropped = projected.pop()
    if (dropped === undefined) break
    droppedPredecessors++
    totalBytes = byteLength(JSON.stringify(projected))
  }

  return {
    predecessors: projected,
    droppedPredecessors,
    truncated: truncated || droppedPredecessors > 0,
    totalBytes,
  }
}

export function makeHandoffOperations(input: { readonly readDb: Db }) {
  const { readDb } = input

  /**
   * Bootstrap-free bounded projection over a task's declared predecessors.
   * Reads only Swarm collaboration tables; never touches Session message, part,
   * or history rows. The Swarm identity is derived from the successor task row,
   * never from the caller, so admission cannot select cross-Swarm state.
   *
   * Query cost is a bounded fanout of at most `limits.predecessors` point
   * reads per dimension, each with its own `LIMIT`. A single noisy predecessor
   * therefore cannot starve a later predecessor's window.
   */
  const taskHandoff = Effect.fn("Swarm.taskHandoff")(function* (
    taskID: Swarm.TaskID,
    options?: { readonly swarmID?: Swarm.ID; readonly limits?: HandoffLimits },
  ) {
    const limits = options?.limits ?? HANDOFF_LIMITS
    const successor = yield* readDb
      .select({ swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskTable)
      .where(eq(SwarmTaskTable.id, taskID))
      .get()
      .pipe(Effect.orDie)
    // Caller-supplied Swarm identity is a fence, not a selector: an admission
    // path that believes it is in another Swarm gets an empty handoff rather
    // than cross-Swarm collaboration state.
    if (successor === undefined || (options?.swarmID !== undefined && options.swarmID !== successor.swarmID))
      return buildHandoff({ predecessors: [], deliverables: [], shared: [] }, limits)
    const swarmID = successor.swarmID

    // Bound DAG degree at the query, not after materializing every edge.
    const edgeRows = yield* readDb
      .select()
      .from(SwarmTaskDependencyTable)
      .where(eq(SwarmTaskDependencyTable.task_id, taskID))
      .orderBy(asc(SwarmTaskDependencyTable.depends_on_task_id))
      .limit(limits.predecessors + 1)
      .all()
      .pipe(Effect.orDie)
    const droppedPredecessors = Math.max(0, edgeRows.length - limits.predecessors)
    const edges = edgeRows.slice(0, limits.predecessors)
    if (edges.length === 0)
      return buildHandoff({ predecessors: [], deliverables: [], shared: [] }, limits)

    const predecessorIDs = edges.map((edge) => edge.depends_on_task_id)
    const taskRows = yield* readDb
      .select({
        id: SwarmTaskTable.id,
        // Column projection, not `select()`: the full task row also carries the
        // unbounded `description` and `acceptance` JSON, which this handoff does
        // not consume and must therefore never transfer.
        title: sql<string>`substr(${SwarmTaskTable.title}, 1, ${HANDOFF_READ_CLAMPS.taskTitle})`,
        status: SwarmTaskTable.status,
        timeCompleted: SwarmTaskTable.time_completed,
        semanticRetryCount: SwarmTaskTable.semantic_retry_count,
      })
      .from(SwarmTaskTable)
      .where(and(eq(SwarmTaskTable.swarm_id, swarmID), inArray(SwarmTaskTable.id, predecessorIDs)))
      .orderBy(asc(SwarmTaskTable.id))
      .all()
      .pipe(Effect.orDie)
    const byID = new Map(taskRows.map((row) => [row.id, row] as const))

    const predecessors: HandoffPredecessorRow[] = []
    for (const edge of edges) {
      const row = byID.get(edge.depends_on_task_id)
      if (row === undefined) continue
      // One bounded point read of the append-only run trace per prerequisite.
      // A terminal task must be explained by a run with the same terminal
      // status. Admission time is not outcome order under retries/races, so the
      // authoritative run is the newest matching terminal settlement by
      // ended_at, with id as the deterministic tie-breaker.
      const terminalRunStatus =
        row.status === "completed" || row.status === "failed" || row.status === "cancelled"
          ? row.status
          : undefined
      const latestRun =
        terminalRunStatus === undefined
          ? []
          : yield* readDb
              .select({
                status: SwarmTaskRunTable.status,
                memberID: SwarmTaskRunTable.member_id,
                failureKind: SwarmTaskRunTable.failure_kind,
                failureDetail: sql<string | null>`substr(${SwarmTaskRunTable.failure_detail}, 1, ${HANDOFF_READ_CLAMPS.failureDetail})`,
                failureLength: sql<number>`length(${SwarmTaskRunTable.failure_detail})`,
                resultSummary: sql<string | null>`substr(${SwarmTaskRunTable.result_summary}, 1, ${HANDOFF_READ_CLAMPS.resultSummary})`,
              })
              .from(SwarmTaskRunTable)
              .where(
                and(
                  eq(SwarmTaskRunTable.task_id, row.id),
                  eq(SwarmTaskRunTable.status, terminalRunStatus),
                ),
              )
              .orderBy(desc(SwarmTaskRunTable.ended_at), desc(SwarmTaskRunTable.id))
              .limit(1)
              .all()
              .pipe(Effect.orDie)
      predecessors.push({
        taskID: row.id,
        requirement: edge.requirement,
        title: row.title,
        status: row.status,
        completed: row.timeCompleted !== null,
        outcome: outcomeOf(row.status, latestRun[0], limits),
        semanticRetryCount: row.semanticRetryCount,
        resultMemberID:
          row.status === "completed" && latestRun[0]?.status === "completed" ? latestRun[0].memberID : undefined,
        resultSummary:
          row.status === "completed" && latestRun[0]?.status === "completed"
            ? latestRun[0].resultSummary?.trim() ?? ""
            : "",
      })
    }
    if (predecessors.length === 0)
      return buildHandoff({ predecessors: [], deliverables: [], shared: [], droppedPredecessors }, limits)

    const deliverables: HandoffDeliverableRow[] = []
    const shared: HandoffSharedRow[] = []
    for (const predecessor of predecessors) {
      // Newest-first: the most recent settled knowledge is the relevant one, and
      // the order is stable for identical timestamps.
      const deliverableRows = yield* readDb
        .select({
          id: SwarmDeliverableTable.id,
          memberID: SwarmDeliverableTable.member_id,
          verdict: SwarmDeliverableTable.verdict,
          summary: sql<string>`substr(${SwarmDeliverableTable.summary}, 1, ${HANDOFF_READ_CLAMPS.deliverableSummary})`,
          refs: sql<string>`substr(${SwarmDeliverableTable.refs}, 1, ${HANDOFF_READ_CLAMPS.deliverableList})`,
          files: sql<string>`substr(${SwarmDeliverableTable.files}, 1, ${HANDOFF_READ_CLAMPS.deliverableList})`,
        })
        .from(SwarmDeliverableTable)
        .innerJoin(SwarmTaskRunTable, eq(SwarmDeliverableTable.task_run_id, SwarmTaskRunTable.id))
        .where(
          and(eq(SwarmDeliverableTable.swarm_id, swarmID), eq(SwarmTaskRunTable.task_id, predecessor.taskID)),
        )
        .orderBy(desc(SwarmDeliverableTable.time_created), desc(SwarmDeliverableTable.id))
        .limit(limits.deliverables)
        .all()
        .pipe(Effect.orDie)
      for (const row of deliverableRows) {
        const refs = parseBoundedList(row.refs)
        const files = parseBoundedList(row.files)
        deliverables.push({
          id: row.id,
          taskID: predecessor.taskID,
          memberID: row.memberID,
          summary: row.summary,
          refs: refs.items,
          files: files.items,
          verdict: row.verdict ?? undefined,
          listsClamped: refs.truncated || files.truncated,
        })
      }

      // Only task-tagged shared state belongs to a predecessor's handoff; untagged
      // Blackboard keys are Swarm-wide and are read on demand, not injected here.
      const sharedRows = yield* readDb
        .select({
          key: sql<string>`substr(${SwarmBlackboardTable.key}, 1, ${HANDOFF_READ_CLAMPS.sharedKey})`,
          contentType: sql<string>`substr(${SwarmBlackboardTable.content_type}, 1, ${HANDOFF_READ_CLAMPS.sharedKey})`,
          version: SwarmBlackboardTable.version,
          authorMemberID: SwarmBlackboardTable.author_member_id,
          value: sql<string>`substr(${SwarmBlackboardTable.value}, 1, ${HANDOFF_READ_CLAMPS.sharedValue})`,
        })
        .from(SwarmBlackboardTable)
        .where(
          and(
            eq(SwarmBlackboardTable.swarm_id, swarmID),
            eq(SwarmBlackboardTable.task_id, predecessor.taskID),
          ),
        )
        .orderBy(asc(SwarmBlackboardTable.key))
        .limit(limits.sharedEntries)
        .all()
        .pipe(Effect.orDie)
      for (const row of sharedRows) {
        shared.push({
          taskID: predecessor.taskID,
          key: row.key,
          contentType: row.contentType,
          version: row.version,
          authorMemberID: row.authorMemberID,
          value: row.value,
          valueClamped: byteLength(row.value) >= HANDOFF_READ_CLAMPS.sharedValue,
        })
      }
    }

    return buildHandoff({ predecessors, deliverables, shared, droppedPredecessors }, limits)
  })

  return { taskHandoff }
}