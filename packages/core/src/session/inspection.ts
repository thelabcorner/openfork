export * as SessionInspection from "./inspection"

import { Context, Effect, Layer } from "effect"
import { and, desc, eq, inArray, isNull, like, lt, or } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionTurnProvenance } from "../v1/session-turn-provenance"
import { MessageTable, PartTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"

const MAX_LIST = 100
const MAX_MESSAGES = 100
const MAX_MESSAGE_TEXT_BYTES = 8 * 1024

export interface SessionRow {
  readonly id: SessionSchema.ID
  readonly projectID: string
  readonly workspaceID?: string
  readonly parentID?: SessionSchema.ID
  readonly title: string
  /**
   * Native durable location. Internal-only: transport adapters must project it
   * through their own authority boundary before egress.
   */
  readonly directory: string
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
    readonly accountID?: string
    readonly variant?: string
  }
  readonly pausedAt?: number
  readonly archivedAt?: number
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MessageRow {
  readonly id: string
  readonly role: string
  readonly kind: SessionTurnProvenance.SemanticKind
  readonly owner?: "user" | "host"
  readonly source?: string
  readonly provenanceConfidence?: "explicit" | "legacy-inferred"
  readonly createdAt: number
  readonly completedAt?: number
  readonly text: string
  readonly truncated: boolean
}

export interface MessagePage {
  readonly items: readonly MessageRow[]
  readonly more: boolean
  /** Pass back as beforeMessageID to continue toward older messages. */
  readonly beforeMessageID?: string
}

export interface ListInput {
  readonly limit?: number
  readonly search?: string
  readonly parentID?: SessionSchema.ID
  readonly roots?: boolean
  readonly includeArchived?: boolean
  readonly before?: {
    readonly updatedAt: number
    readonly id: SessionSchema.ID
  }
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<readonly SessionRow[]>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionRow | undefined>
  readonly children: (parentID: SessionSchema.ID, limit?: number) => Effect.Effect<readonly SessionRow[]>
  readonly messages: (input: {
    readonly sessionID: SessionSchema.ID
    readonly limit?: number
    readonly beforeMessageID?: string
  }) => Effect.Effect<MessagePage>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionInspection") {}

function normalizeLimit(input: number | undefined, max: number, fallback: number) {
  if (input === undefined || !Number.isFinite(input)) return fallback
  return Math.max(1, Math.min(max, Math.floor(input)))
}

function project(row: typeof SessionTable.$inferSelect): SessionRow {
  return {
    id: SessionSchema.ID.make(row.id),
    projectID: row.project_id,
    ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
    ...(row.parent_id ? { parentID: SessionSchema.ID.make(row.parent_id) } : {}),
    title: row.title,
    directory: row.directory,
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.model
      ? {
          model: {
            providerID: row.model.providerID,
            modelID: row.model.id,
            ...(row.model.accountID ? { accountID: row.model.accountID } : {}),
            ...(row.model.variant ? { variant: row.model.variant } : {}),
          },
        }
      : {}),
    ...(row.paused_at === null || row.paused_at === undefined ? {} : { pausedAt: row.paused_at }),
    ...(row.time_archived === null || row.time_archived === undefined ? {} : { archivedAt: row.time_archived }),
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
    },
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

function truncateUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service

    const get = Effect.fn("SessionInspection.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* readDb
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? project(row) : undefined
    })

    const list = Effect.fn("SessionInspection.list")(function* (input: ListInput = {}) {
      const conditions = []
      if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
      if (input.parentID) conditions.push(eq(SessionTable.parent_id, input.parentID))
      if (input.roots) conditions.push(isNull(SessionTable.parent_id))
      if (!input.includeArchived) conditions.push(isNull(SessionTable.time_archived))
      if (input.before) {
        conditions.push(
          or(
            lt(SessionTable.time_updated, input.before.updatedAt),
            and(eq(SessionTable.time_updated, input.before.updatedAt), lt(SessionTable.id, input.before.id)),
          )!,
        )
      }

      const rows = yield* readDb
        .select()
        .from(SessionTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(normalizeLimit(input.limit, MAX_LIST, 50))
        .all()
        .pipe(Effect.orDie)
      return rows.map(project)
    })

    const children = Effect.fn("SessionInspection.children")(function* (parentID: SessionSchema.ID, limit?: number) {
      const rows = yield* readDb
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, parentID))
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(normalizeLimit(limit, MAX_LIST, 50))
        .all()
        .pipe(Effect.orDie)
      return rows.map(project)
    })

    const messages = Effect.fn("SessionInspection.messages")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly limit?: number
      readonly beforeMessageID?: string
    }) {
      const limit = normalizeLimit(input.limit, MAX_MESSAGES, 20)
      const anchor = input.beforeMessageID
        ? yield* readDb
            .select({ id: MessageTable.id, time: MessageTable.time_created })
            .from(MessageTable)
            .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.beforeMessageID as never)))
            .get()
            .pipe(Effect.orDie)
        : undefined
      const before = anchor
        ? or(
            lt(MessageTable.time_created, anchor.time),
            and(eq(MessageTable.time_created, anchor.time), lt(MessageTable.id, anchor.id)),
          )
        : undefined
      const rows = yield* readDb
        .select()
        .from(MessageTable)
        .where(before ? and(eq(MessageTable.session_id, input.sessionID), before) : eq(MessageTable.session_id, input.sessionID))
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const more = rows.length > limit
      const selected = (more ? rows.slice(0, limit) : rows).toReversed()
      if (selected.length === 0) return { items: [], more: false } satisfies MessagePage

      const ids = selected.map((row) => row.id)
      const partRows = yield* readDb
        .select({ messageID: PartTable.message_id, id: PartTable.id, text: PartTable.search_text })
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      const textByMessage = new Map<string, string[]>()
      for (const part of partRows) {
        if (!part.text) continue
        const list = textByMessage.get(part.messageID) ?? []
        list.push(part.text)
        textByMessage.set(part.messageID, list)
      }

      const items = selected.map((row) => {
        const info = row.data as {
          readonly role?: string
          readonly provenance?: {
            readonly owner: "user" | "host"
            readonly source: string
            readonly sourceMessageID?: string
            readonly ref?: string
            readonly lifetime?: "historical"
          }
          readonly time?: { readonly completed?: number }
        }
        const semantic = SessionTurnProvenance.semanticKindInfo(info)
        const provenance = SessionTurnProvenance.resolveInfo(info)
        const compact = truncateUtf8((textByMessage.get(row.id) ?? []).join("\n"), MAX_MESSAGE_TEXT_BYTES)
        return {
          id: row.id,
          role: info.role ?? "unknown",
          kind: semantic,
          ...(provenance
            ? {
                owner: provenance.owner,
                source: provenance.source,
                provenanceConfidence: provenance.confidence,
              }
            : {}),
          createdAt: row.time_created,
          ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
          text: compact.text,
          truncated: compact.truncated,
        } satisfies MessageRow
      })
      const oldest = selected[0]
      return {
        items,
        more,
        ...(more && oldest ? { beforeMessageID: oldest.id } : {}),
      } satisfies MessagePage
    })

    return Service.of({
      list,
      get,
      children,
      messages,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
