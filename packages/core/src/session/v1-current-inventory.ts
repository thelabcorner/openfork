export * as V1CurrentInventory from "./v1-current-inventory"

import { and, asc, eq, gt } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { PartID } from "../v1/session"
import type { SessionSchema } from "./schema"
import { legacyPartKind, legacyPartStatus } from "./legacy-part-query"
import { PartTable } from "./sql"

/**
 * Source-backed migration inventory, NOT permission to cut over a Session.
 * V1 has twelve part kinds; current Assistant.content only has text,
 * reasoning and tool. Even those three need metadata/id/event differential
 * proof, and a pending/running tool additionally needs a recovery fence.
 *
 * The scanner intentionally returns only small routing facts. Large part
 * bodies stay in SQLite until a separately approved versioned reducer reads
 * them. Unknown JSON/version failures stop rather than losing a part.
 */
const MODELED = new Set(["text", "reasoning", "tool"])
const KNOWN = new Set([
  "text", "reasoning", "tool", "file", "subtask", "step-start",
  "step-finish", "snapshot", "patch", "agent", "retry", "compaction",
])

type Reader = Pick<Database.Interface["db"], "select">
export type Item = {
  readonly partID: PartID
  readonly messageID: string
  readonly kind: string | null
  readonly status: string | null
  readonly representation: "current-content-candidate" | "requires-legacy-bridge" | "unknown"
  readonly unsettledTool: boolean
}

export const page = Effect.fn("V1CurrentInventory.page")(function* (
  db: Reader,
  input: { readonly sessionID: SessionSchema.ID; readonly after?: PartID; readonly limit?: number },
) {
  const limit = input.limit ?? 128
  if (!Number.isInteger(limit) || limit < 1 || limit > 128)
    return yield* Effect.die(new Error("V1 migration inventory page must contain 1–128 parts"))
  const rows = yield* db.select({
    id: PartTable.id,
    messageID: PartTable.message_id,
    kind: legacyPartKind,
    status: legacyPartStatus,
  }).from(PartTable)
    .where(and(
      eq(PartTable.session_id, input.sessionID),
      input.after ? gt(PartTable.id, input.after) : undefined,
    ))
    .orderBy(asc(PartTable.id))
    .limit(limit + 1).all().pipe(Effect.orDie)
  const more = rows.length > limit
  const items: Item[] = rows.slice(0, limit).map((row) => ({
    partID: row.id,
    messageID: row.messageID,
    kind: row.kind,
    status: row.status,
    representation: row.kind === null || !KNOWN.has(row.kind)
      ? "unknown"
      : MODELED.has(row.kind) ? "current-content-candidate" : "requires-legacy-bridge",
    unsettledTool: row.kind === "tool" && (row.status === "pending" || row.status === "running"),
  }))
  return {
    items,
    more,
    cursor: more ? items.at(-1)?.partID : undefined,
    counts: {
      candidates: items.filter((row) => row.representation === "current-content-candidate").length,
      bridges: items.filter((row) => row.representation === "requires-legacy-bridge").length,
      unknown: items.filter((row) => row.representation === "unknown").length,
      unsettled: items.filter((row) => row.unsettledTool).length,
    },
  }
})