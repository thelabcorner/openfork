/**
 * Explicit, bounded and writer-fair reconciliation of old V1 part facts.
 *
 * Candidate discovery and OPCL decompression happen on the WAL reader, BEFORE
 * a short writer transaction. The final update is compare-and-swap on both
 * version and stored JSON: a concurrent producer update always wins and can
 * never be overwritten by the stale repair.
 *
 * Never run automatically during Context-pane activation. For older databases,
 * call repeatedly with nextCursor, respecting cancellation and pacing between
 * pages. A dangling OPCL reference remains v0 and totals stay unavailable.
 */
import { Effect, Exit } from "effect"
import { and, eq, gt, lt } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { PartTable } from "@opencode-ai/core/session/sql"
import { contextPartFacts, CONTEXT_PART_FACT_VERSION } from "@opencode-ai/core/session/context-part-facts"
import { PartID, SessionID } from "@/session/schema"

export const MAX_CONTEXT_BACKFILL_BATCH = 100
const supportedKinds = new Set([
  "text", "subtask", "reasoning", "file", "tool", "step-start",
  "step-finish", "snapshot", "patch", "agent", "retry", "compaction",
])

export const backfillLegacyContextFacts = Effect.fn("ContextFacts.backfillLegacy")(function* (input: {
  sessionID: string
  limit?: number
  after?: string
}) {
  const limit = input.limit ?? MAX_CONTEXT_BACKFILL_BATCH
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CONTEXT_BACKFILL_BATCH)
    return yield* Effect.fail(new Error("Context facts backfill batch must be between 1 and 100"))

  const { db, readDb } = yield* Database.Service
  const sessionID = SessionID.make(input.sessionID)
  // The query-only WAL reader can decode arbitrarily old OPCL refs without
  // holding a transaction on the primary event writer. The keyset cursor means
  // unresolved refs never trap a repair run on the same first N rows.
  const rows = yield* readDb.select({
    id: PartTable.id,
    data: PartTable.data,
    opaque: PartTable.context_opaque,
  }).from(PartTable)
    .where(and(
      eq(PartTable.session_id, sessionID),
      lt(PartTable.context_projection_version, CONTEXT_PART_FACT_VERSION),
      input.after ? gt(PartTable.id, PartID.make(input.after)) : undefined,
    ))
    .orderBy(PartTable.id)
    .limit(limit)
    .all().pipe(Effect.orDie)

  const candidates: Array<{
    row: (typeof rows)[number]
    facts: ReturnType<typeof contextPartFacts>
    compaction: boolean
    physicalOpaque: boolean
    decodedRef: boolean
  }> = []
  let skippedOpaque = 0
  let skippedMalformed = 0
  for (const row of rows) {
    let data: unknown = row.data
    const isRef = data !== null && typeof data === "object" &&
      !Array.isArray(data) && "$cdbRef" in data
    if (isRef) {
      // The canonical decoder validates content/hash/codec when OPCL is
      // enabled. A dangling ref or disabled OPCL must never be promoted.
      const resolution = yield* Effect.exit(EventV2.resolveProjectionRef(
        readDb, input.sessionID, "part.data", data,
      ))
      const decoded = Exit.isSuccess(resolution) ? resolution.value : undefined
      if (decoded === undefined || decoded === data) {
        skippedOpaque++
        continue
      }
      data = decoded
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      skippedOpaque++
      continue
    }
    const source = data as { type?: unknown; text?: unknown; state?: unknown }
    const state = source.state as Record<string, unknown> | undefined
    if (typeof source.type !== "string" || !supportedKinds.has(source.type) ||
      ((source.type === "text" || source.type === "reasoning") && typeof source.text !== "string") ||
      (source.type === "tool" && (
        !state || typeof state.status !== "string" ||
        (state.status === "completed" && typeof state.output !== "string") ||
        (state.status === "error" && typeof state.error !== "string")
      ))) {
      skippedMalformed++
      continue
    }
    candidates.push({
      row,
      facts: contextPartFacts(source as { type: string }),
      compaction: source.type === "compaction",
      physicalOpaque: row.opaque || isRef,
      decodedRef: isRef,
    })
  }

  // Short writer-critical section: no OPCL decoding, history queries, or
  // unbounded scanning while holding the primary SQLite writer transaction.
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      let upgraded = 0
      let rehydrated = 0
      let skippedConflict = 0
      for (const candidate of candidates) {
        const updated = yield* tx.update(PartTable).set({
          ...candidate.facts,
          context_compaction: candidate.compaction,
          // Preserve the physical OPCL marker even after verifying its v1
          // facts, so arbitrary JSON hydrators still know it is externalized.
          context_opaque: candidate.physicalOpaque,
        }).where(and(
          eq(PartTable.id, candidate.row.id),
          eq(PartTable.session_id, sessionID),
          eq(PartTable.context_projection_version, 0),
          eq(PartTable.data, candidate.row.data),
        )).returning({ id: PartTable.id }).get().pipe(Effect.orDie)
        if (!updated) {
          skippedConflict++
          continue
        }
        upgraded++
        if (candidate.decodedRef) rehydrated++
      }
      return {
        scanned: rows.length,
        upgraded,
        skippedOpaque,
        skippedMalformed,
        skippedConflict,
        rehydrated,
        completePage: rows.length < limit,
        nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined,
      }
    }),
  )
})
