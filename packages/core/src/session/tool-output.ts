import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { MessageTable, SessionToolOutputTable } from "./sql"
import { SessionLegacyToolIndex } from "./legacy-tool-index"
import type { SessionSchema } from "./schema"
import type { MessageID } from "../v1/session"

export const CHUNK_CODE_POINTS = 32 * 1024
export const PAGE_CODE_POINTS = 32 * 1024

export type Owner = {
  sessionID: SessionSchema.ID
  messageID: MessageID
  toolCallID: string
}

export type Page = {
  text: string
  offset: number
  totalChars: number
  totalLines: number
  complete: boolean
  nextOffset?: number
}

/** Split without breaking a UTF-16 surrogate pair; offsets are Unicode code points. */
export function splitText(value: string, maxCodePoints = CHUNK_CODE_POINTS) {
  const chunks: { text: string; startOffset: number }[] = []
  let index = 0
  let offset = 0
  while (index < value.length) {
    let end = index
    let count = 0
    while (end < value.length && count < maxCodePoints) {
      const code = value.charCodeAt(end)
      end += code >= 0xd800 && code <= 0xdbff && end + 1 < value.length &&
        value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff ? 2 : 1
      count++
    }
    chunks.push({ text: value.slice(index, end), startOffset: offset })
    index = end
    offset += count
  }
  return chunks
}

function takeCodePoints(value: string, count: number) {
  let end = 0
  let seen = 0
  while (end < value.length && seen < count) {
    const code = value.charCodeAt(end)
    end += code >= 0xd800 && code <= 0xdbff && end + 1 < value.length &&
      value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff ? 2 : 1
    seen++
  }
  return { head: value.slice(0, end), tail: value.slice(end), codePoints: seen }
}

/** Bounded, amortized-linear coalescing for high-rate one-character deltas. */
export function createChunkBuffer(maxCodePoints = CHUNK_CODE_POINTS) {
  let pending = ""
  let pendingCodePoints = 0
  return {
    get pendingCodePoints() {
      return pendingCodePoints
    },
    push(value: string) {
      pending += value
      pendingCodePoints += Array.from(value).length
      const ready: string[] = []
      while (pendingCodePoints >= maxCodePoints) {
        const taken = takeCodePoints(pending, maxCodePoints)
        if (!taken.codePoints) break
        ready.push(taken.head)
        pending = taken.tail
        pendingCodePoints -= taken.codePoints
      }
      return ready
    },
    flush() {
      if (!pending) return []
      const result = pending
      pending = ""
      pendingCodePoints = 0
      return [result]
    },
  }
}

const ownerWhere = (owner: Owner) =>
  and(
    eq(SessionToolOutputTable.session_id, owner.sessionID),
    eq(SessionToolOutputTable.message_id, owner.messageID),
    eq(SessionToolOutputTable.tool_call_id, owner.toolCallID),
  )

/**
 * A retention owner is only meaningful when it names a durable ToolPart.
 * Refusal is deliberate: callers treat a retention defect as "recovery
 * unavailable" and must never convert it into a failed tool result.
 */
const assertDurableToolCall = Effect.fn("SessionToolOutput.assertDurableToolCall")(function* (owner: Owner) {
  if (!owner.toolCallID) {
    return yield* Effect.die(new Error("Cannot retain tool output without a tool-call identity"))
  }
  const { db } = yield* Database.Service
  const match = yield* SessionLegacyToolIndex.exists(db, {
    sessionID: owner.sessionID, messageID: owner.messageID, callID: owner.toolCallID,
  })
  if (!match) return yield* Effect.die(new Error("Tool output owner does not match a durable tool call"))
})

export const begin = Effect.fn("SessionToolOutput.begin")(function* (owner: Owner) {
  const { db } = yield* Database.Service
  yield* assertDurableToolCall(owner)
  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const message = yield* tx
            .select({ sessionID: MessageTable.session_id })
            .from(MessageTable)
            .where(and(eq(MessageTable.id, owner.messageID), eq(MessageTable.session_id, owner.sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!message) return yield* Effect.die(new Error("Cannot retain tool output for a missing session message"))

          // A completed owner is already authoritative. A duplicate/replayed
          // writer must never erase it. Incomplete rows are crash residue and
          // may be restarted safely under the same durable owner.
          const existing = yield* tx
            .select({ complete: SessionToolOutputTable.complete })
            .from(SessionToolOutputTable)
            .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
            .get()
            .pipe(Effect.orDie)
          if (existing?.complete) {
            return yield* Effect.die(new Error("Tool output owner is already complete"))
          }

          yield* tx.delete(SessionToolOutputTable).where(ownerWhere(owner)).run().pipe(Effect.orDie)
          yield* tx
            .insert(SessionToolOutputTable)
            .values({
              session_id: owner.sessionID,
              message_id: owner.messageID,
              tool_call_id: owner.toolCallID,
              chunk_index: -1,
              start_offset: 0,
              text: null,
              total_chars: 0,
              total_lines: 0,
              complete: false,
              time_created: Date.now(),
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const persist = Effect.fn("SessionToolOutput.persist")(function* (owner: Owner, value: string) {
  const { db } = yield* Database.Service
  const chunks = splitText(value)
  const lines = (value.match(/\n/g) ?? []).length
  const totalChars = Array.from(value).length
  yield* assertDurableToolCall(owner)
  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const message = yield* tx
            .select({ sessionID: MessageTable.session_id })
            .from(MessageTable)
            .where(and(eq(MessageTable.id, owner.messageID), eq(MessageTable.session_id, owner.sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!message) return yield* Effect.die(new Error("Cannot retain tool output for a missing session message"))

          const existing = yield* tx
            .select({ complete: SessionToolOutputTable.complete })
            .from(SessionToolOutputTable)
            .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
            .get()
            .pipe(Effect.orDie)
          // First completed retention wins for a durable tool-call owner. This
          // prevents a later provider projection from replacing a producer's
          // richer/full stream with its already-bounded result.
          if (existing?.complete) return

          yield* tx.delete(SessionToolOutputTable).where(ownerWhere(owner)).run().pipe(Effect.orDie)
          yield* tx
            .insert(SessionToolOutputTable)
            .values({
              session_id: owner.sessionID,
              message_id: owner.messageID,
              tool_call_id: owner.toolCallID,
              chunk_index: -1,
              start_offset: 0,
              text: null,
              total_chars: 0,
              total_lines: 0,
              complete: false,
              time_created: Date.now(),
            })
            .run()
            .pipe(Effect.orDie)

          for (const [chunk_index, chunk] of chunks.entries()) {
            yield* tx
              .insert(SessionToolOutputTable)
              .values({
                session_id: owner.sessionID,
                message_id: owner.messageID,
                tool_call_id: owner.toolCallID,
                chunk_index,
                start_offset: chunk.startOffset,
                text: chunk.text,
                total_chars: null,
                total_lines: null,
                complete: false,
                time_created: Date.now(),
              })
              .run()
              .pipe(Effect.orDie)
          }
          yield* tx
            .update(SessionToolOutputTable)
            .set({ total_chars: totalChars, total_lines: lines, complete: true })
            .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

/**
 * Append a completed shell-output chunk. The header remains `complete=false`
 * until close/finalize, so a crash can never expose a falsely complete result.
 */
export const append = Effect.fn("SessionToolOutput.append")(function* (
  owner: Owner,
  chunkIndex: number,
  startOffset: number,
  value: string,
) {
  if (!value) return
  const { db } = yield* Database.Service
  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const header = yield* tx
            .select({ complete: SessionToolOutputTable.complete })
            .from(SessionToolOutputTable)
            .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
            .get()
            .pipe(Effect.orDie)
          if (!header || header.complete) return yield* Effect.die(new Error("Tool output stream is not open"))
          yield* tx
            .insert(SessionToolOutputTable)
            .values({
              session_id: owner.sessionID,
              message_id: owner.messageID,
              tool_call_id: owner.toolCallID,
              chunk_index: chunkIndex,
              start_offset: startOffset,
              text: value,
              total_chars: null,
              total_lines: null,
              complete: false,
              time_created: Date.now(),
            })
            .run()
            .pipe(Effect.orDie)
          yield* tx
            .update(SessionToolOutputTable)
            .set({
              total_chars: startOffset + Array.from(value).length,
              total_lines: sql<number>`coalesce(${SessionToolOutputTable.total_lines}, 0) + ${((value.match(/\n/g) ?? []).length)}`,
            })
            .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const finish = Effect.fn("SessionToolOutput.finish")(function* (owner: Owner) {
  const { db } = yield* Database.Service
  const finished = yield* db
    .update(SessionToolOutputTable)
    .set({ complete: true })
    .where(and(ownerWhere(owner), eq(SessionToolOutputTable.chunk_index, -1)))
    .returning({ toolCallID: SessionToolOutputTable.tool_call_id })
    .get()
    .pipe(Effect.orDie)
  if (!finished) return yield* Effect.die(new Error("Tool output stream is not open"))
})

export const page = Effect.fn("SessionToolOutput.page")(function* (input: Owner & { offset: number }) {
  const { readDb } = yield* Database.Service
  const offset = Math.max(0, Math.floor(input.offset))
  const header = yield* readDb
    .select({ totalChars: SessionToolOutputTable.total_chars, totalLines: SessionToolOutputTable.total_lines, complete: SessionToolOutputTable.complete })
    .from(SessionToolOutputTable)
    .where(and(ownerWhere(input), eq(SessionToolOutputTable.chunk_index, -1)))
    .get()
    .pipe(Effect.orDie)
  if (!header) return undefined
  const totalChars = header.totalChars ?? 0
  const end = Math.min(totalChars, offset + PAGE_CODE_POINTS)
  const rows = end <= offset ? [] : yield* readDb
    .select({ text: SessionToolOutputTable.text, startOffset: SessionToolOutputTable.start_offset })
    .from(SessionToolOutputTable)
    .where(
      and(
        eq(SessionToolOutputTable.session_id, input.sessionID),
        eq(SessionToolOutputTable.message_id, input.messageID),
        eq(SessionToolOutputTable.tool_call_id, input.toolCallID),
        sql`${SessionToolOutputTable.chunk_index} >= 0`,
        sql`${SessionToolOutputTable.start_offset} < ${end}`,
        sql`${SessionToolOutputTable.start_offset} + length(${SessionToolOutputTable.text}) > ${offset}`,
      ),
    )
    .orderBy(SessionToolOutputTable.chunk_index)
    .all()
    .pipe(Effect.orDie)
  let remaining = PAGE_CODE_POINTS
  let text = ""
  for (const row of rows) {
    if (remaining <= 0) break
    const value = row.text ?? ""
    const from = Math.max(0, offset - row.startOffset)
    const selected = Array.from(value).slice(from, from + remaining)
    text += selected.join("")
    remaining -= selected.length
  }
  const actualEnd = offset + Array.from(text).length
  return {
    text,
    offset,
    totalChars,
    totalLines: header.totalLines ?? 0,
    complete: header.complete,
    ...(actualEnd < totalChars ? { nextOffset: actualEnd } : {}),
  } satisfies Page
})
