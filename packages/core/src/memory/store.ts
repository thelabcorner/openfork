export * as MemoryStore from "./store"

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { MemoryAnchors } from "./anchors"
import {
  MemoryAnchorTable,
  MemoryEntryTable,
  MemoryEvidenceTable,
  MemoryIngestTable,
  MemorySuppressionTable,
  MemoryTopicTable,
} from "./sql"
import { MemorySchema } from "./schema"

type Row = typeof MemoryEntryTable.$inferSelect
type TopicRow = typeof MemoryTopicTable.$inferSelect

export interface UpsertTopicInput {
  readonly scope: MemorySchema.Scope
  readonly projectID: string | null
  readonly workspaceID: string | null
  readonly key: string
  readonly title: string
  readonly description: string
}

export interface InsertInput {
  readonly scope: MemorySchema.Scope
  readonly kind: MemorySchema.Kind
  readonly origin: MemorySchema.Origin
  readonly status: MemorySchema.Status
  readonly topic: { readonly id: string }
  readonly title: string
  readonly content: string
  readonly hash: string
  readonly anchors: MemorySchema.Anchor[]
  readonly stableKey: string | null
  readonly projectID?: string | null
  readonly workspaceID?: string | null
  readonly evidence: ReadonlyArray<{
    readonly source_type: MemorySchema.EvidenceSource
    readonly session_id: string | null
    readonly message_id: string | null
    readonly part_id: string | null
    readonly commit_sha: string | null
    readonly path: string | null
    readonly line_start: number | null
    readonly line_end: number | null
    readonly source_hash: string | null
    readonly excerpt: string | null
  }>
  /** When set, an active entry with this stable key is superseded atomically. */
  readonly supersedeKey?: string | undefined
}

export interface Interface {
  readonly upsertTopic: (input: UpsertTopicInput) => Effect.Effect<{ id: string }>
  readonly topicByKey: (
    context: MemorySchema.Context,
    key: string,
  ) => Effect.Effect<{ id: string; key: string; title: string; description: string } | undefined>
  readonly topics: (context: MemorySchema.Context) => Effect.Effect<MemorySchema.Topic[]>
  readonly markTopicDirty: (topicID: string) => Effect.Effect<void>
  readonly findByHash: (input: { scope: MemorySchema.Scope; hash: string }) => Effect.Effect<MemorySchema.Entry | undefined>
  readonly insert: (input: InsertInput) => Effect.Effect<MemorySchema.Entry, unknown>
  readonly get: (id: string) => Effect.Effect<MemorySchema.Entry | undefined>
  readonly evidence: (id: string) => Effect.Effect<MemorySchema.Evidence[]>
  readonly anchorsFor: (ids: string[]) => Effect.Effect<Map<string, string[]>>
  readonly touch: (ids: string[]) => Effect.Effect<void>
  readonly searchRanked: (input: {
    ranked: SQL
    anchors: string[]
    kinds?: MemorySchema.Kind[]
    includeHistory: boolean
    limit: number
  }) => Effect.Effect<MemorySchema.SearchHit[]>
  readonly timeline: (input: {
    id?: string
    key?: string
    projectID: string
    workspaceID: string | null
  }) => Effect.Effect<MemorySchema.Entry[]>
  readonly topicEntries: (topicID: string) => Effect.Effect<MemorySchema.Entry[]>
  readonly setProjection: (topicID: string, projection: string) => Effect.Effect<void>
  readonly tombstone: (entry: MemorySchema.Entry, reason?: string) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MemoryStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database

    const upsertTopic = Effect.fn("MemoryStore.upsertTopic")(function* (input: UpsertTopicInput) {
      const now = Date.now()
      const existing = yield* db
        .select()
        .from(MemoryTopicTable)
        .where(
          and(
            eq(MemoryTopicTable.scope, input.scope),
            input.projectID === null
              ? isNull(MemoryTopicTable.project_id)
              : eq(MemoryTopicTable.project_id, input.projectID),
            input.workspaceID === null
              ? isNull(MemoryTopicTable.workspace_id)
              : eq(MemoryTopicTable.workspace_id, input.workspaceID),
            eq(MemoryTopicTable.key, input.key),
          ),
        )
        .get()
        .pipe(Effect.orDie)

      if (existing) return { id: existing.id }

      const id = MemorySchema.nextTopicID()
      yield* db
        .insert(MemoryTopicTable)
        .values({
          id,
          scope: input.scope,
          project_id: input.projectID,
          workspace_id: input.workspaceID,
          key: input.key,
          title: input.title,
          description: input.description,
          pinned: 0,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .pipe(Effect.orDie)

      // A concurrent insert may have won the race; re-select so callers always
      // get the canonical row.
      const row = yield* db
        .select({ id: MemoryTopicTable.id })
        .from(MemoryTopicTable)
        .where(
          and(
            eq(MemoryTopicTable.scope, input.scope),
            input.projectID === null
              ? isNull(MemoryTopicTable.project_id)
              : eq(MemoryTopicTable.project_id, input.projectID),
            input.workspaceID === null
              ? isNull(MemoryTopicTable.workspace_id)
              : eq(MemoryTopicTable.workspace_id, input.workspaceID),
            eq(MemoryTopicTable.key, input.key),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return { id: row?.id ?? id }
    })

    const topics = Effect.fn("MemoryStore.topics")(function* (context: MemorySchema.Context) {
      // Hard scope filter: global rows plus this project's rows plus this
      // workspace's rows. Nothing else is ever visible (INV-1).
      const rows = yield* db
        .select()
        .from(MemoryTopicTable)
        .where(
          sql`(${MemoryTopicTable.scope} = 'global' AND ${MemoryTopicTable.project_id} IS NULL)
              OR (${MemoryTopicTable.scope} = 'project' AND ${MemoryTopicTable.project_id} = ${context.projectID})
              OR (${MemoryTopicTable.scope} = 'workspace' AND ${MemoryTopicTable.workspace_id} = ${context.workspaceID})`,
        )
        .all()
        .pipe(Effect.orDie)

      const ids = rows.map((row) => row.id)
      const counts = yield* entryCounts(ids)
      return rows
        .map((row) => decodeTopic(row, counts.get(row.id) ?? 0))
        .toSorted((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          if (b.entryCount !== a.entryCount) return b.entryCount - a.entryCount
          return a.key.localeCompare(b.key)
        })
    })

    const entryCounts = Effect.fn("MemoryStore.entryCounts")(function* (ids: string[]) {
      if (ids.length === 0) return new Map<string, number>()
      const rows = yield* db
        .select({
          topic_id: MemoryEntryTable.topic_id,
          count: sql<number>`count(*)`,
        })
        .from(MemoryEntryTable)
        .where(and(inArray(MemoryEntryTable.topic_id, ids), eq(MemoryEntryTable.status, "active")))
        .groupBy(MemoryEntryTable.topic_id)
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [row.topic_id, Number(row.count)]))
    })

    const topicByKey: Interface["topicByKey"] = Effect.fn("MemoryStore.topicByKey")(function* (context, key) {
      const row = yield* db
        .select()
        .from(MemoryTopicTable)
        .where(
          and(
            eq(MemoryTopicTable.key, key),
            sql`(${MemoryTopicTable.scope} = 'global' AND ${MemoryTopicTable.project_id} IS NULL)
                OR (${MemoryTopicTable.scope} = 'project' AND ${MemoryTopicTable.project_id} = ${context.projectID})
                OR (${MemoryTopicTable.scope} = 'workspace' AND ${MemoryTopicTable.workspace_id} = ${context.workspaceID})`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return { id: row.id, key: row.key, title: row.title, description: row.description }
    })

    const markTopicDirty = Effect.fn("MemoryStore.markTopicDirty")(function* (topicID: string) {
      yield* db
        .update(MemoryTopicTable)
        .set({ projection_dirty: 1, time_updated: Date.now() })
        .where(eq(MemoryTopicTable.id, topicID))
        .pipe(Effect.orDie)
    })

    const findByHash: Interface["findByHash"] = Effect.fn("MemoryStore.findByHash")(function* (input) {
      const row = yield* db
        .select()
        .from(MemoryEntryTable)
        .where(and(eq(MemoryEntryTable.scope, input.scope), eq(MemoryEntryTable.content_hash, input.hash)))
        .get()
        .pipe(Effect.orDie)
      return row ? yield* hydrate(row) : undefined
    })

    const insert = Effect.fn("MemoryStore.insert")(function* (input: InsertInput) {
      const now = Date.now()
      const id = MemorySchema.nextID()
      const searchText = MemoryAnchors.searchText({
        title: input.title,
        content: input.content,
        anchors: input.anchors,
      })

      // Supersession + insert is one transaction: a keyed fact must never be
      // left half-written (INV-8).
      const superseded = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          let previous: Row | undefined
          if (input.supersedeKey) {
            previous = yield* tx
              .select()
              .from(MemoryEntryTable)
              .where(
                and(
                  eq(MemoryEntryTable.scope, input.scope),
                  eq(MemoryEntryTable.stable_key, input.supersedeKey),
                  eq(MemoryEntryTable.status, "active"),
                ),
              )
              .get()
              .pipe(Effect.orDie)

            if (previous) {
              yield* tx
                .update(MemoryEntryTable)
                .set({
                  status: "superseded",
                  valid_to: now,
                  superseded_by_id: id,
                  time_updated: now,
                })
                .where(eq(MemoryEntryTable.id, previous.id))
                .pipe(Effect.orDie)
            }
          }

          yield* tx
            .insert(MemoryEntryTable)
            .values({
              id,
              topic_id: input.topic.id,
              scope: input.scope,
              project_id: input.projectID ?? null,
              workspace_id: input.workspaceID ?? null,
              kind: input.kind,
              origin: input.origin,
              stable_key: input.stableKey,
              title: input.title,
              content: input.content,
              search_text: searchText,
              status: input.status,
              valid_from: now,
              valid_to: null,
              supersedes_id: previous?.id ?? null,
              superseded_by_id: null,
              content_hash: input.hash,
              time_created: now,
              time_updated: now,
              time_last_used: null,
              use_count: 0,
            })
            .pipe(Effect.orDie)

          if (input.anchors.length > 0) {
            yield* tx.insert(MemoryAnchorTable).values(
              input.anchors.map((anchor) => ({
                id: MemorySchema.nextEvidenceID(),
                memory_id: id,
                kind: anchor.kind,
                value: anchor.value,
                normalized: anchor.normalized,
              })),
            )
          }

          if (input.evidence.length > 0) {
            yield* tx.insert(MemoryEvidenceTable).values(
              input.evidence.map((item) => ({
                id: MemorySchema.nextEvidenceID(),
                memory_id: id,
                source_type: item.source_type,
                session_id: item.session_id,
                message_id: item.message_id,
                part_id: item.part_id,
                commit_sha: item.commit_sha,
                path: item.path,
                line_start: item.line_start,
                line_end: item.line_end,
                source_hash: item.source_hash,
                observed_at: now,
                excerpt: item.excerpt,
              })),
            )
          }

          return previous
        }),
      )

      const row = yield* db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`Memory entry ${id} vanished after insert`))
      if (superseded) yield* markTopicDirty(superseded.topic_id)
      return yield* hydrate(row)
    })

    const get = Effect.fn("MemoryStore.get")(function* (id: string) {
      const row = yield* db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get().pipe(Effect.orDie)
      return row ? yield* hydrate(row) : undefined
    })

    const evidence = Effect.fn("MemoryStore.evidence")(function* (id: string) {
      const rows = yield* db
        .select()
        .from(MemoryEvidenceTable)
        .where(eq(MemoryEvidenceTable.memory_id, id))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => MemorySchema.Evidence.make({
        id: MemorySchema.EvidenceID.make(row.id),
        memory_id: MemorySchema.ID.make(row.memory_id),
        source_type: row.source_type as MemorySchema.EvidenceSource,
        session_id: row.session_id,
        message_id: row.message_id,
        part_id: row.part_id,
        commit_sha: row.commit_sha,
        path: row.path,
        line_start: row.line_start,
        line_end: row.line_end,
        source_hash: row.source_hash,
        observed_at: row.observed_at,
        excerpt: row.excerpt,
      }))
    })

    const anchorsFor = Effect.fn("MemoryStore.anchorsFor")(function* (ids: string[]) {
      if (ids.length === 0) return new Map<string, string[]>()
      const rows = yield* db
        .select({
          memory_id: MemoryAnchorTable.memory_id,
          kind: MemoryAnchorTable.kind,
          value: MemoryAnchorTable.value,
        })
        .from(MemoryAnchorTable)
        .where(inArray(MemoryAnchorTable.memory_id, ids))
        .all()
        .pipe(Effect.orDie)
      const map = new Map<string, string[]>()
      for (const row of rows) {
        const label = row.kind === "identifier" ? row.value : `${row.kind}:${row.value}`
        const list = map.get(row.memory_id) ?? []
        if (list.length < 8) list.push(label)
        map.set(row.memory_id, list)
      }
      return map
    })

    const hydrate = Effect.fn("MemoryStore.hydrate")(function* (row: Row) {
      const [topic] = yield* db
        .select({ key: MemoryTopicTable.key, title: MemoryTopicTable.title })
        .from(MemoryTopicTable)
        .where(eq(MemoryTopicTable.id, row.topic_id))
        .all()
        .pipe(Effect.orDie)
      const counts = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(MemoryEvidenceTable)
        .where(eq(MemoryEvidenceTable.memory_id, row.id))
        .get()
        .pipe(Effect.orDie)
      return MemorySchema.Entry.make({
        id: MemorySchema.ID.make(row.id),
        topic_id: MemorySchema.TopicID.make(row.topic_id),
        topic_key: topic?.key ?? "",
        topic_title: topic?.title ?? "",
        scope: row.scope as MemorySchema.Scope,
        project_id: row.project_id,
        workspace_id: row.workspace_id,
        kind: row.kind as MemorySchema.Kind,
        origin: row.origin as MemorySchema.Origin,
        stable_key: row.stable_key,
        title: row.title,
        content: row.content,
        status: row.status as MemorySchema.Status,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        supersedes_id: row.supersedes_id ? MemorySchema.ID.make(row.supersedes_id) : null,
        superseded_by_id: row.superseded_by_id ? MemorySchema.ID.make(row.superseded_by_id) : null,
        content_hash: row.content_hash,
        time_created: row.time_created,
        time_updated: row.time_updated,
        time_last_used: row.time_last_used,
        use_count: row.use_count,
        evidenceCount: Number(counts?.count ?? 0),
      })
    })

    const touch = Effect.fn("MemoryStore.touch")(function* (ids: string[]) {
      if (ids.length === 0) return
      const now = Date.now()
      yield* db
        .update(MemoryEntryTable)
        .set({ time_last_used: now, use_count: sql`${MemoryEntryTable.use_count} + 1` })
        .where(inArray(MemoryEntryTable.id, ids))
        .pipe(Effect.orDie, Effect.ignore)
    })

    const searchRanked: Interface["searchRanked"] = Effect.fn("MemoryStore.searchRanked")(function* (input) {
      const rows = yield* db
        .all<{
          id: string
          topic_id: string
          topic_key: string
          topic_title: string
          scope: string
          kind: string
          origin: string
          title: string
          content: string
          status: string
          time_updated: number
          score: number
          evidence_count: number
        }>(sql`
          SELECT
            e.id, e.topic_id, t.key AS topic_key, t.title AS topic_title,
            e.scope, e.kind, e.origin, e.title, e.content, e.status,
            e.time_updated, f.score,
            (SELECT count(*) FROM memory_evidence v WHERE v.memory_id = e.id) AS evidence_count
          FROM (${input.ranked}) f
          JOIN memory_entry e ON e.rowid = f.rowid
          JOIN memory_topic t ON t.id = e.topic_id
          ORDER BY f.score
        `)
        .pipe(Effect.orDie)

      if (rows.length === 0) return [] as MemorySchema.SearchHit[]

      // Exact-anchor boost: a memory whose anchors literally contain a query
      // anchor outranks one that merely matched prose (§8.3).
      const anchorMap = yield* anchorsFor(rows.map((row) => row.id))
      const wanted = new Set(input.anchors)

      const scored = rows.map((row) => {
        const anchors = anchorMap.get(row.id) ?? []
        const normalized = anchors.map((anchor) => anchor.replace(/^[a-z]+:/, "")).map(MemoryAnchors.normalize)
        const exact = normalized.filter((value) => wanted.has(value)).length
        const base = -row.score
        const boost = exact * 2
        return { row, anchors, score: Number((base + boost).toFixed(4)) }
      })

      scored.sort((a, b) => b.score - a.score || b.row.time_updated - a.row.time_updated)
      const limited = input.includeHistory
        ? scored
        : scored.filter((item) => item.row.status === "active")
      const kinds = input.kinds ? new Set<string>(input.kinds) : undefined

      return limited
        .filter((item) => (kinds ? kinds.has(item.row.kind) : true))
        .slice(0, input.limit)
        .map((item) =>
          MemorySchema.SearchHit.make({
            id: MemorySchema.ID.make(item.row.id),
            topic_key: item.row.topic_key,
            topic_title: item.row.topic_title,
            kind: item.row.kind as MemorySchema.Kind,
            origin: item.row.origin as MemorySchema.Origin,
            scope: item.row.scope as MemorySchema.Scope,
            title: item.row.title,
            snippet: snippet(item.row.content),
            status: item.row.status as MemorySchema.Status,
            evidenceCount: Number(item.row.evidence_count),
            anchors: item.anchors,
            time_updated: item.row.time_updated,
            score: item.score,
          }),
        )
    })

    const timeline: Interface["timeline"] = Effect.fn("MemoryStore.timeline")(function* (input) {
      const seed = input.id
        ? yield* db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, input.id)).get().pipe(Effect.orDie)
        : input.key
          ? yield* db
              .select()
              .from(MemoryEntryTable)
              .where(eq(MemoryEntryTable.stable_key, input.key))
              .all()
              .pipe(Effect.orDie, Effect.map((rows) => rows[0]))
          : undefined
      if (!seed) return [] as MemorySchema.Entry[]

      // Walk the supersession chain in both directions from the seed.
      const ids = new Set<string>([seed.id])
      let cursor: string | null = seed.superseded_by_id
      while (cursor && !ids.has(cursor)) {
        ids.add(cursor)
        const next: { superseded_by_id: string | null } | undefined = yield* db
          .select({ superseded_by_id: MemoryEntryTable.superseded_by_id })
          .from(MemoryEntryTable)
          .where(eq(MemoryEntryTable.id, cursor))
          .get()
          .pipe(Effect.orDie)
        cursor = next?.superseded_by_id ?? null
      }
      cursor = seed.supersedes_id
      while (cursor && !ids.has(cursor)) {
        ids.add(cursor)
        const previous: { supersedes_id: string | null } | undefined = yield* db
          .select({ supersedes_id: MemoryEntryTable.supersedes_id })
          .from(MemoryEntryTable)
          .where(eq(MemoryEntryTable.id, cursor))
          .get()
          .pipe(Effect.orDie)
        cursor = previous?.supersedes_id ?? null
      }

      const rows = yield* db
        .select()
        .from(MemoryEntryTable)
        .where(inArray(MemoryEntryTable.id, [...ids]))
        .all()
        .pipe(Effect.orDie)
      const entries = yield* Effect.forEach(rows, hydrate)
      return entries.toSorted((a, b) => a.valid_from - b.valid_from)
    })

    const topicEntries = Effect.fn("MemoryStore.topicEntries")(function* (topicID: string) {
      const rows = yield* db
        .select()
        .from(MemoryEntryTable)
        .where(eq(MemoryEntryTable.topic_id, topicID))
        .all()
        .pipe(Effect.orDie)
      const entries = yield* Effect.forEach(rows, hydrate)
      return entries.toSorted((a, b) => b.time_updated - a.time_updated)
    })

    const setProjection = Effect.fn("MemoryStore.setProjection")(function* (topicID: string, projection: string) {
      yield* db
        .update(MemoryTopicTable)
        .set({
          projection,
          projection_dirty: 0,
          projection_version: sql`${MemoryTopicTable.projection_version} + 1`,
          time_updated: Date.now(),
        })
        .where(eq(MemoryTopicTable.id, topicID))
        .pipe(Effect.orDie)
    })

    const tombstone = Effect.fn("MemoryStore.tombstone")(function* (entry: MemorySchema.Entry, reason?: string) {
      const now = Date.now()
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(MemoryEntryTable)
            .set({ status: "tombstoned", valid_to: now, time_updated: now })
            .where(eq(MemoryEntryTable.id, entry.id))
            .pipe(Effect.orDie)
          // Without this row the next background pass over the same source
          // session would resurrect the deleted memory.
          yield* tx
            .insert(MemorySuppressionTable)
            .values({
              id: MemorySchema.nextEvidenceID(),
              scope: entry.scope,
              project_id: entry.project_id,
              workspace_id: entry.workspace_id,
              content_hash: entry.content_hash,
              memory_id: entry.id,
              reason: reason ?? "user forget",
              time_created: now,
            })
            .pipe(Effect.orDie)
          yield* tx
            .update(MemoryTopicTable)
            .set({ projection_dirty: 1, time_updated: now })
            .where(eq(MemoryTopicTable.id, entry.topic_id))
            .pipe(Effect.orDie)
        }),
      )
    })

    return Service.of({
      upsertTopic,
      topicByKey,
      topics,
      markTopicDirty,
      findByHash,
      insert,
      get,
      evidence,
      anchorsFor,
      touch,
      searchRanked,
      timeline,
      topicEntries,
      setProjection,
      tombstone,
    })
  }),
)

function decodeTopic(row: TopicRow, entryCount: number): MemorySchema.Topic {
  return MemorySchema.Topic.make({
    id: MemorySchema.TopicID.make(row.id),
    scope: row.scope as MemorySchema.Scope,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    key: row.key,
    title: row.title,
    description: row.description,
    pinned: row.pinned === 1,
    entryCount,
    time_updated: row.time_updated,
  })
}

function snippet(content: string, max = 240): string {
  const flat = content.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node] })
