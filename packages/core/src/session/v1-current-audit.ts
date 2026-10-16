export * as V1CurrentAudit from "./v1-current-audit"

import { createHash } from "node:crypto"
import { and, asc, eq, gt, inArray, or } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { resolveProjectionRef } from "../event"
import { SessionV1 } from "../v1/session"
import type { SessionSchema } from "./schema"
import { MessageTable, PartTable } from "./sql"
import { V1CurrentBridge } from "./v1-current-bridge"

/**
 * Bounded, explicit read-only differential audit against REAL V1 SQLite
 * projections. Never runs on app startup, never writes session_message, never
 * asserts snapshot isolation across separate invocations.
 *
 * The input cursor is a (time_created, id) tuple, not a time-only cursor.
 * Concurrent writers can invalidate the collected evidence: no reported
 * digest is a cutover certificate until the execution-owner fence is held.
 */
type Reader = Pick<Database.Interface["db"], "select">
export type Cursor = {
  readonly timeCreated: number
  readonly messageID: SessionV1.MessageID
}
export type Result = {
  readonly messageID: SessionV1.MessageID
  readonly timeCreated: number
  readonly role: "user" | "assistant" | "unknown"
  readonly partCount: number
  readonly sourceHash?: string
  readonly currentType?: string
  readonly bridgedParts: number
  readonly unresolvedTools: number
  readonly blockers: readonly string[]
  readonly verdict: "shadow-verified" | "blocked"
}

export const page = Effect.fn("V1CurrentAudit.page")(function* (
  db: Reader,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly after?: Cursor
    readonly limit?: number
  },
) {
  const limit = input.limit ?? 8
  if (!Number.isInteger(limit) || limit < 1 || limit > 16)
    return yield* Effect.die(new Error("V1 shadow audit permits 1–16 messages per page"))
  const rows = yield* db.select().from(MessageTable)
    .where(and(
      eq(MessageTable.session_id, input.sessionID),
      input.after ? or(
        gt(MessageTable.time_created, input.after.timeCreated),
        and(
          eq(MessageTable.time_created, input.after.timeCreated),
          gt(MessageTable.id, input.after.messageID),
        ),
      ) : undefined,
    ))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .limit(limit + 1).all().pipe(Effect.orDie)

  const more = rows.length > limit
  const batch = rows.slice(0, limit)
  const ids = batch.map((row) => row.id)
  const partRows = ids.length ? yield* db.select().from(PartTable)
    .where(and(
      eq(PartTable.session_id, input.sessionID),
      inArray(PartTable.message_id, ids),
    ))
    .orderBy(asc(PartTable.message_id), asc(PartTable.id))
    .all().pipe(Effect.orDie) : []
  const parts = new Map<string, typeof partRows>()
  for (const row of partRows) {
    const list = parts.get(row.message_id) ?? []
    list.push(row)
    parts.set(row.message_id, list)
  }

  const summaries: Result[] = []
  for (const row of batch) {
    const owned = parts.get(row.id) ?? []
    const body = yield* resolveProjectionRef(db, input.sessionID, "message.data", row.data)
    const rawParts: unknown[] = []
    for (const part of owned) {
      const value = yield* resolveProjectionRef(db, input.sessionID, "part.data", part.data)
      rawParts.push({
        ...(value && typeof value === "object" ? value : {}),
        id: part.id,
        sessionID: part.session_id,
        messageID: part.message_id,
      })
    }
    const source = {
      ...(body && typeof body === "object" ? body : {}),
      id: row.id,
      sessionID: row.session_id,
    }
    const role = source.role === "user" || source.role === "assistant" ? source.role : "unknown"
    try {
      // The bridge validates complete V1 schemas and ownership before it
      // creates any V2 candidate. A rejected source cannot disappear from
      // the inventory merely because it is not part of the V2 union.
      const envelope = V1CurrentBridge.lower({
        info: source, parts: rawParts,
      } as unknown as SessionV1.WithParts)
      V1CurrentBridge.verify(envelope)
      // V1 assistant parent edges are not represented in current Assistant.
      // A foreign/missing parent would silently disappear from V2 history
      // semantics unless explicitly caught before any future cutover.
      const parentID = envelope.source.info.role === "assistant"
        ? envelope.source.info.parentID : undefined
      const parent = parentID ? yield* db.select({ id: MessageTable.id })
        .from(MessageTable)
        .where(and(
          eq(MessageTable.id, parentID),
          eq(MessageTable.session_id, input.sessionID),
        )).get().pipe(Effect.orDie) : undefined
      const orphan = !!parentID && !parent
      summaries.push({
        messageID: row.id,
        timeCreated: row.time_created,
        role,
        partCount: owned.length,
        sourceHash: envelope.sourceHash,
        currentType: envelope.candidate?.type,
        bridgedParts: envelope.mappings.filter((item) => item.destination === "legacy-bridge").length,
        unresolvedTools: owned.filter((_, i) => {
          const part = rawParts[i] as { type?: unknown; state?: { status?: unknown } }
          return part.type === "tool" && (part.state?.status === "pending" || part.state?.status === "running")
        }).length,
        blockers: orphan ? [...envelope.blockers, "orphan-parent"] : envelope.blockers,
        verdict: orphan ? "blocked" : "shadow-verified",
      })
    } catch (error) {
      const invalidHash = createHash("sha256")
        .update(JSON.stringify({ source, parts: rawParts })).digest("hex")
      summaries.push({
        messageID: row.id,
        timeCreated: row.time_created,
        role, partCount: owned.length,
        sourceHash: invalidHash,
        bridgedParts: 0, unresolvedTools: 0,
        // The detail in a schema failure can include private user prompts,
        // tool outputs and signed reasoning. This compact audit returns only
        // a failure category, never source payload in diagnostics.
        blockers: [
          "invalid-or-ambiguous-v1-source",
          `validation-error:${error instanceof Error ? error.name : "unknown"}`,
        ],
        verdict: "blocked",
      })
    }
  }

  const last = batch.at(-1)
  const digest = createHash("sha256").update(JSON.stringify(
    summaries.map((item) => [item.messageID, item.sourceHash ?? null, item.verdict]),
  )).digest("hex")
  return {
    items: summaries,
    more,
    cursor: more && last ? { messageID: last.id, timeCreated: last.time_created } : undefined,
    pageDigest: digest,
    counts: {
      messages: summaries.length,
      parts: summaries.reduce((n, row) => n + row.partCount, 0),
      blocked: summaries.filter((row) => row.verdict === "blocked").length,
      bridgedParts: summaries.reduce((n, row) => n + row.bridgedParts, 0),
      unresolvedTools: summaries.reduce((n, row) => n + row.unresolvedTools, 0),
    },
    /** Deliberate hard gate: audit evidence alone cannot grant native writes. */
    cutoverSafe: false as const,
  }
})

/** Bounded scan composed of bounded pages. Outputs only hashed evidence and
 * aggregated blockers; never accumulates full transcripts or issues writes.
 * Exhaustion is not a cutover certificate without a durable owner/event fence.
 */
export const summarize = Effect.fn("V1CurrentAudit.summarize")(function* (
  db: Reader,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly after?: Cursor
    readonly pageSize?: number
    readonly maxPages?: number
  },
) {
  const maxPages = input.maxPages ?? 64
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 128)
    return yield* Effect.die(new Error("V1 audit permits 1–128 pages per bounded scan"))
  let cursor = input.after
  const chain = createHash("sha256")
  const totals = { messages: 0, parts: 0, blocked: 0, bridgedParts: 0, unresolvedTools: 0 }
  const blockers: Record<string, number> = Object.create(null)
  for (let i = 0; i < maxPages; i++) {
    const batch = yield* page(db, {
      sessionID: input.sessionID, after: cursor, limit: input.pageSize,
    })
    chain.update(batch.pageDigest + "\n")
    for (const key of Object.keys(totals) as Array<keyof typeof totals>)
      totals[key] += batch.counts[key]
    for (const item of batch.items) {
      for (const reason of item.blockers) {
        const category = reason.startsWith("unsupported-part:")
          ? reason.split(":").slice(0, 2).join(":")
          : reason.startsWith("v1-extra:")
          ? "v1-extra"
          : reason.startsWith("file-source:")
          ? "file-source"
          : reason.startsWith("validation-error:")
          ? "validation-error"
          : reason
        blockers[category] = (blockers[category] ?? 0) + 1
      }
    }
    if (!batch.more) return {
      complete: true as const,
      pageCount: i + 1,
      counts: totals,
      blockerCounts: { ...blockers },
      digest: chain.digest("hex"),
      cursor: undefined,
      cutoverSafe: false as const,
    }
    // A full page must have a stable continuation key. Never silently stop
    // with a successful-looking report on a malformed cursor.
    if (!batch.cursor) return yield* Effect.die(new Error("V1 audit lost pagination cursor"))
    cursor = batch.cursor
  }
  return {
    complete: false as const,
    pageCount: maxPages,
    counts: totals,
    blockerCounts: { ...blockers },
    digest: chain.digest("hex"),
    cursor,
    cutoverSafe: false as const,
  }
})
