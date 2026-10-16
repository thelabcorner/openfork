export * as SessionStaleReasoning from "./stale-reasoning"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventValueTable } from "../event/sql"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type ProviderMetadata = NonNullable<SessionMessage.AssistantReasoning["providerMetadata"]>

const REPLAY_HANDLE_KEYS = ["reasoningEncryptedContent", "itemId"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const withoutReplayHandles = (box: Record<string, unknown>) => {
  if (!REPLAY_HANDLE_KEYS.some((key) => key in box)) return box
  const next = { ...box }
  for (const key of REPLAY_HANDLE_KEYS) delete next[key]
  return next
}

export function stripProviderMetadata(metadata: ProviderMetadata | undefined): ProviderMetadata | undefined {
  if (metadata === undefined) return undefined
  let changed = false
  const next: Record<string, Record<string, unknown>> = {}
  for (const [provider, values] of Object.entries(metadata)) {
    if (!isRecord(values)) {
      next[provider] = values
      continue
    }
    const box = withoutReplayHandles(values)
    if (box === values) {
      next[provider] = values
      continue
    }
    changed = true
    if (Object.keys(box).length > 0) next[provider] = box
  }
  if (!changed) return metadata
  return Object.keys(next).length === 0 ? undefined : next
}

export function stripReasoningPart(part: SessionMessage.AssistantReasoning): SessionMessage.AssistantReasoning {
  const providerMetadata = stripProviderMetadata(part.providerMetadata)
  if (providerMetadata === part.providerMetadata) return part
  const { providerMetadata: _ignored, ...rest } = part
  return providerMetadata === undefined ? rest : { ...rest, providerMetadata }
}

export function stripMessage(message: SessionMessage.Message): SessionMessage.Message {
  if (message.type !== "assistant") return message
  let changed = false
  const content = message.content.map((part) => {
    if (part.type !== "reasoning") return part
    const next = stripReasoningPart(part)
    if (next !== part) changed = true
    return next
  })
  return changed ? { ...message, content } : message
}

const projectionRefID = (data: unknown) => {
  if (!isRecord(data)) return undefined
  if (Object.keys(data).length !== 1) return undefined
  return typeof data.$cdbRef === "string" ? data.$cdbRef : undefined
}

const releaseProjectionRef = (tx: Pick<DatabaseService, "update">, sessionID: SessionSchema.ID, data: unknown) => {
  const valueID = projectionRefID(data)
  if (valueID === undefined) return Effect.void
  return tx
    .update(EventValueTable)
    .set({ refs: sql`CASE WHEN ${EventValueTable.refs} > 0 THEN ${EventValueTable.refs} - 1 ELSE 0 END` })
    .where(and(eq(EventValueTable.aggregate_id, sessionID), eq(EventValueTable.value_id, valueID)))
    .run()
    .pipe(Effect.orDie)
}

export const persist = Effect.fn("SessionStaleReasoning.persist")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  messages: readonly SessionMessage.Message[],
) {
  const candidates = messages.filter((message) => stripMessage(message) !== message)
  if (candidates.length === 0) return [] as SessionMessage.Message[]

  const encode = Schema.encodeSync(SessionMessage.Message)
  const repaired: SessionMessage.Message[] = []
  yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        for (const message of candidates) {
          const row = yield* tx
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!row) continue
          const base = yield* SessionMessageProjection.decodeBaseRow(tx, row)
          const stripped = stripMessage(base)
          if (stripped === base) continue
          const encoded = encode(stripped)
          const { id: _id, type: _type, ...data } = encoded
          yield* tx
            .update(SessionMessageTable)
            .set({ data: data as typeof SessionMessageTable.$inferInsert.data })
            .where(and(eq(SessionMessageTable.id, stripped.id), eq(SessionMessageTable.session_id, sessionID)))
            .run()
            .pipe(Effect.orDie)
          yield* releaseProjectionRef(tx, sessionID, row.data)
          repaired.push(stripMessage(message))
        }
      }),
    { behavior: "immediate" },
  ).pipe(Effect.orDie)
  return repaired
})
