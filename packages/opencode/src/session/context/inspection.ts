export * as ContextInspection from "./inspection"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionContextStateTable } from "@opencode-ai/core/session/sql"
import { MessageV2 } from "@/session/message-v2"
import { SessionLedger } from "./ledger"
import { EffectiveContextCompiler } from "./compiler"
import { projectContextPreview } from "./preview"

// At most 150 newest messages / three small SQL pages use the low-latency
// shared WAL reader. Larger histories belong to the lazily opened, independent
// analytical scan lane so unrelated provider/UI reads do not queue behind a
// long-running context inspector. Even deeply compacted 5k+ physical histories
// usually resolve within these three pages without opening the scan lane.
export const INTERACTIVE_HISTORY_PAGE_BUDGET = 3

/**
 * One committed read-only WAL snapshot of the canonical effective V1 history,
 * compaction-tail ordering, and conversation-control overlay state.
 *
 * This is a domain inspection surface, NOT the Usage/occupancy scalar snapshot,
 * and never loads or acquires a workspace Instance. A deferred transaction
 * guarantees that separate cursor pages and overlays cannot refer to different
 * committed versions during a single request.
 */
export const read = Effect.fn("ContextInspection.read")(function* (sessionID: string) {
  const { readDb, scanDb } = yield* Database.Service
  const from = (reader: Database.DatabaseShape, maxPages?: number) => reader.transaction((tx) =>
    Effect.gen(function* () {
      const messages = yield* MessageV2.readCompactedFrom(sessionID as any, tx, { maxPages })
      const overlays = yield* tx
        .select({
          message_id: SessionContextStateTable.message_id,
          excluded: SessionContextStateTable.excluded,
          pinned: SessionContextStateTable.pinned,
          override_data: SessionContextStateTable.override_data,
        })
        .from(SessionContextStateTable)
        .where(eq(SessionContextStateTable.session_id, sessionID as any))
        .all()
        .pipe(Effect.orDie)
      return { messages, overlays }
    }),
    { behavior: "deferred" },
  )
  // The bounded first attempt is a full committed WAL snapshot. When its page
  // budget is exceeded, the transaction is rolled back before acquiring the
  // scan connection. Retry *all* history+overlays as one fresh snapshot; never
  // stitch rows from two commits or return a plausible incomplete ledger.
  return yield* from(readDb, INTERACTIVE_HISTORY_PAGE_BUDGET).pipe(
    Effect.catchIf(
      (error): error is MessageV2.ContextHistoryScanRequired => error instanceof MessageV2.ContextHistoryScanRequired,
      () => Effect.flatMap(scanDb(), (reader) => from(reader)),
    ),
  )
})

export type Snapshot = Effect.Success<ReturnType<typeof read>>

export function ledger(sessionID: string, snapshot: Snapshot) {
  return SessionLedger.buildWithRows(
    { sessionID, messages: snapshot.messages },
    snapshot.overlays,
  )
}

export function preview(sessionID: string, snapshot: Snapshot) {
  const totals = ledger(sessionID, snapshot)
  const state = new Map(snapshot.overlays.map((row) => [
    row.message_id,
    {
      excluded: row.excluded,
      pinned: row.pinned,
      overrideData: (row.override_data as Record<string, unknown> | null) ?? undefined,
    },
  ] as const))
  const compiled = EffectiveContextCompiler.compile({ messages: snapshot.messages, state })
  return projectContextPreview({ messages: snapshot.messages, ledger: totals, compiled })
}
