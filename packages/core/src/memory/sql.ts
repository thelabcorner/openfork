import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Canonical durable memory store.
 *
 * Invariants encoded here:
 * - INV-1 every row carries scope + project_id/workspace_id so retrieval can
 *   filter BEFORE ranking; there is no unscoped query path.
 * - INV-3 projections are derived; `memory_topic.projection` is rebuildable
 *   from active entries, so a bad projection can never erase learning.
 * - INV-4 `memory_evidence` keeps the non-memory source of every automated
 *   entry, so recalled memory can never become its own justification.
 * - INV-8 supersession is first-class: old rows keep valid_to and
 *   superseded_by_id rather than being overwritten.
 */

export const MemoryTopicTable = sqliteTable(
  "memory_topic",
  {
    id: text().$type<string>().primaryKey(),
    scope: text().$type<"global" | "project" | "workspace">().notNull(),
    project_id: text(),
    workspace_id: text(),

    key: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),

    // Derived, rebuildable view. Never a second source of truth.
    projection: text(),
    projection_version: integer().notNull().default(0),
    projection_dirty: integer().notNull().default(1),

    pinned: integer().notNull().default(0),

    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("memory_topic_scope_key_idx").on(table.scope, table.project_id, table.workspace_id, table.key),
    index("memory_topic_project_idx").on(table.project_id),
    index("memory_topic_workspace_idx").on(table.workspace_id),
  ],
)

export const MemoryEntryTable = sqliteTable(
  "memory_entry",
  {
    id: text().$type<string>().primaryKey(),

    topic_id: text()
      .notNull()
      .references(() => MemoryTopicTable.id, { onDelete: "cascade" }),

    scope: text().$type<"global" | "project" | "workspace">().notNull(),
    project_id: text(),
    workspace_id: text(),

    kind: text().notNull(),
    origin: text().notNull(),

    // Optional single semantic slot (package-manager, test-runner, ...) that
    // lets a new fact supersede the old one deterministically.
    stable_key: text(),

    title: text().notNull(),
    content: text().notNull(),
    // title + content + anchor values; feeds the FTS5 index.
    search_text: text().notNull().default(""),

    status: text().$type<"active" | "superseded" | "quarantined" | "tombstoned">().notNull().default("active"),

    valid_from: integer().notNull(),
    valid_to: integer(),

    supersedes_id: text(),
    superseded_by_id: text(),

    content_hash: text().notNull(),

    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_last_used: integer(),
    use_count: integer().notNull().default(0),
  },
  (table) => [
    index("memory_entry_topic_idx").on(table.topic_id),
    index("memory_entry_scope_idx").on(table.scope, table.project_id, table.workspace_id),
    index("memory_entry_status_idx").on(table.status),
    index("memory_entry_stable_key_idx").on(table.scope, table.project_id, table.stable_key, table.status),
    index("memory_entry_content_hash_idx").on(table.scope, table.content_hash),
    index("memory_entry_time_updated_idx").on(table.time_updated),
  ],
)

export const MemoryEvidenceTable = sqliteTable(
  "memory_evidence",
  {
    id: text().primaryKey(),
    memory_id: text()
      .notNull()
      .references(() => MemoryEntryTable.id, { onDelete: "cascade" }),

    source_type: text().notNull(),

    session_id: text(),
    message_id: text(),
    part_id: text(),

    commit_sha: text(),
    path: text(),
    line_start: integer(),
    line_end: integer(),

    source_hash: text(),
    observed_at: integer().notNull(),

    excerpt: text(),
  },
  (table) => [
    index("memory_evidence_memory_idx").on(table.memory_id),
    index("memory_evidence_session_idx").on(table.session_id),
  ],
)

export const MemoryAnchorTable = sqliteTable(
  "memory_anchor",
  {
    id: text().primaryKey(),
    memory_id: text()
      .notNull()
      .references(() => MemoryEntryTable.id, { onDelete: "cascade" }),

    kind: text().notNull(),
    value: text().notNull(),
    normalized: text().notNull(),
  },
  (table) => [
    index("memory_anchor_normalized_idx").on(table.normalized),
    index("memory_anchor_kind_value_idx").on(table.kind, table.value),
    index("memory_anchor_memory_idx").on(table.memory_id),
  ],
)

/**
 * Per-session ingestion cursor. Chunked, resumable progress is what prevents
 * the "long session produces no memory at all" failure mode (INV-6).
 */
export const MemoryIngestTable = sqliteTable(
  "memory_ingest",
  {
    session_id: text().primaryKey(),

    last_ingested_seq: integer().notNull().default(0),
    target_seq: integer(),

    status: text().$type<"idle" | "queued" | "processing" | "partial" | "failed" | "complete">().notNull(),
    retries: integer().notNull().default(0),

    last_error: text(),

    time_started: integer(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [index("memory_ingest_status_idx").on(table.status)],
)

/**
 * Tombstones. Without them a user deletion is silently undone by the next
 * background ingestion pass over the same old session.
 */
export const MemorySuppressionTable = sqliteTable(
  "memory_suppression",
  {
    id: text().primaryKey(),
    scope: text().notNull(),
    project_id: text(),
    workspace_id: text(),
    content_hash: text(),
    memory_id: text(),
    reason: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("memory_suppression_hash_idx").on(table.scope, table.content_hash),
    index("memory_suppression_memory_idx").on(table.memory_id),
  ],
)

