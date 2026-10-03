import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import type { SessionContextEpochState } from "./context-epoch-state"
import { AgentV2 } from "../agent"
import { isNull, sql } from "drizzle-orm"
import type { Revert } from "@opencode-ai/schema/revert"
import type { SessionGroup } from "@opencode-ai/schema/session-group"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export type SessionMessageSettlement =
  | {
      type: "ended"
      completed: number
      finish: string
      cost: number
      tokens: NonNullable<SessionMessage.Assistant["tokens"]>
      snapshot?: {
        end?: string
        files?: NonNullable<NonNullable<SessionMessage.Assistant["snapshot"]>["files"]>
      }
    }
  | {
      type: "failed"
      completed: number
      error: NonNullable<SessionMessage.Assistant["error"]>
    }

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      accountID?: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
    paused_at: integer(),
    group_id: text(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    // Startup/sidebar hot path:
    //   WHERE project_id=? AND directory=? AND parent_id IS NULL
    //   ORDER BY time_updated DESC LIMIT ?
    //
    // Keep this partial so child sessions do not bloat an index used only for
    // root-session navigation. SQLite can scan the final time_updated key in
    // reverse order, avoiding the temporary sort used by session_project_idx.
    index("session_project_directory_root_updated_idx")
      .on(table.project_id, table.directory, table.time_updated)
      .where(isNull(table.parent_id)),
    // Project-wide sidebar/root census:
    //   WHERE project_id=? AND parent_id IS NULL
    //   ORDER BY time_updated DESC, id DESC LIMIT ?
    //
    // The canonical project store intentionally spans worker directories (for
    // example Scheduled Task run roots), so directory cannot participate in
    // this access path. Include id as the deterministic ordering tie-breaker.
    index("session_project_root_updated_id_idx")
      .on(table.project_id, table.time_updated, table.id)
      .where(isNull(table.parent_id)),
    // V2 sidebar/session-list hot path:
    //   WHERE directory=? AND parent_id IS NULL
    //   ORDER BY time_created DESC, id DESC LIMIT ?
    //
    // V2 list semantics intentionally remain creation-ordered. Include `id`
    // because it is the stable pagination tie-breaker, allowing SQLite to serve
    // the root-only first page directly from the partial index.
    index("session_directory_root_created_id_idx")
      .on(table.directory, table.time_created, table.id)
      .where(isNull(table.parent_id)),
    // OpenFork Home's global Tier 1 projection uses this exact active-root
    // access path, ordered by the last session update rather than creation.
    // This lets SQLite stop after the requested root rows instead of sorting
    // every session for the directory into a temporary B-tree.
    index("session_directory_root_updated_id_idx")
      .on(table.directory, table.time_updated, table.id)
      .where(sql`${table.parent_id} IS NULL AND ${table.time_archived} IS NULL`),
    // Archived sidebar projection: filter a bounded directory set and page
    // root rows by archive time without walking every session in those dirs.
    index("session_directory_root_archived_id_idx")
      .on(table.directory, table.time_archived, table.id)
      .where(sql`${table.parent_id} IS NULL AND ${table.time_archived} IS NOT NULL`),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    index("session_group_idx").on(table.group_id),
  ],
)

export const SessionGroupTable = sqliteTable(
  "session_group",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    position: integer().notNull(),
    kind: text().$type<"user" | "subagent" | "plugin" | "delegation">().notNull().default("user"),
    owner_plugin: text(),
    owner_ref: text(),
    anchor_session_id: text().$type<SessionSchema.ID>(),
    policy: text({ mode: "json" }).$type<{
      autoAddDescendants: boolean
      lockAdded: boolean
      autoDeleteWhenEmpty: boolean
    }>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_archived: integer(),
  },
  (table) => [
    // A root session has one automatic subagent tree. Plugin groups need a
    // different identity: one anchor may participate in several independent
    // groups owned by the same unrelated plugin/integration at the same time.
    uniqueIndex("session_group_subagent_anchor_idx")
      .on(table.kind, table.anchor_session_id)
      .where(sql`${table.kind} = 'subagent' AND ${table.anchor_session_id} IS NOT NULL`),
    uniqueIndex("session_group_plugin_owner_ref_idx")
      .on(table.kind, table.owner_plugin, table.owner_ref)
      .where(sql`${table.kind} = 'plugin' AND ${table.owner_plugin} IS NOT NULL AND ${table.owner_ref} IS NOT NULL`),
  ],
)

export const SessionGroupMemberTable = sqliteTable(
  "session_group_member",
  {
    group_id: text()
      .notNull()
      .references(() => SessionGroupTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    locked: integer({ mode: "boolean" }).notNull().default(false),
    origin: text().$type<SessionGroup.MemberOrigin>().notNull().default("user"),
    origin_plugin: text(),
    origin_ref: text(),
    position: integer().notNull().default(0),
    time_added: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.session_id] }),
    index("session_group_member_session_idx").on(table.session_id),
    index("session_group_member_position_idx").on(table.group_id, table.position),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
    // Extracted searchable text backing the part_fts FTS5 index. Populated by
    // the SessionProjector via SessionSearch.partSearchText; the FTS triggers
    // keep the virtual table in sync on every write.
    search_text: text().notNull().default(""),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
    // Extracted searchable text backing the session_message_fts FTS5 index.
    // Populated by the SessionProjector via SessionSearch.searchText; the FTS
    // triggers keep the virtual table in sync on every write.
    search_text: text().notNull().default(""),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

// Keep hot lifecycle metadata in its own physical record. SQLite rebuilds a
// table record when any column changes, so putting these fields beside a
// multi-MiB `data` value still makes Step.Streamed/Ended/Failed O(message size).
// A 1:1 sidecar makes those writes independent of assistant content size.
export const SessionMessageLifecycleTable = sqliteTable("session_message_lifecycle", {
  message_id: text()
    .$type<SessionMessage.ID>()
    .primaryKey()
    .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
  streamed_at: integer(),
  settlement: text({ mode: "json" }).$type<SessionMessageSettlement>(),
})

// Compact, one-row-per-session observability snapshot. Live token/text deltas
// never write this table; SessionTelemetry keeps those in memory and persists
// only provider-step settlement. This gives cold sidebar/global UI O(1) access
// to context/TPS timing metadata without decoding messages or creating a
// location/instance runtime.
export const SessionTelemetryTable = sqliteTable("session_telemetry", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  assistant_message_id: text().$type<SessionMessage.ID>(),
  provider_id: text(),
  model_id: text(),
  model_name: text(),
  variant: text(),
  context_limit: integer(),
  request_sent_at: integer(),
  first_token_at: integer(),
  streamed_at: integer(),
  completed_at: integer(),
  cost_usd: real(),
  tokens_input: integer().notNull().default(0),
  tokens_output: integer().notNull().default(0),
  tokens_reasoning: integer().notNull().default(0),
  tokens_cache_read: integer().notNull().default(0),
  tokens_cache_write: integer().notNull().default(0),
  generated_ms: integer().notNull().default(0),
  tool_ms: integer().notNull().default(0),
  updated_at: integer().notNull(),
})

// Tool progress/settlement payloads are already durable in EventV2. Do not
// copy multi-MiB native media into a second projection row and do not rewrite
// the growing assistant aggregate. This sidecar stores only tiny pointers to
// the latest durable tool events. Projectors run before the event row insert,
// so these are deliberately not SQL foreign keys; both writes are inside the
// same EventV2 transaction and therefore commit or roll back together.
export const SessionMessageToolOverlayTable = sqliteTable(
  "session_message_tool_overlay",
  {
    message_id: text()
      .$type<SessionMessage.ID>()
      .notNull()
      .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
    call_id: text().notNull(),
    progress_event_id: text(),
    settlement_event_id: text(),
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.call_id] }),
    index("session_message_tool_overlay_message_idx").on(table.message_id),
    index("session_message_tool_overlay_unsettled_idx")
      .on(table.message_id, table.call_id)
      .where(isNull(table.settlement_event_id)),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    kind: text().$type<SessionInput.Kind>().notNull().default("user"),
    admission_class: text().$type<SessionInput.AdmissionClass>().notNull().default("user"),
    user_preemptible: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * Canonical current-model input. Nullable only for pre-migration rows while
     * compatibility mirrors remain; new writers always populate it.
     */
    input: text({ mode: "json" }).$type<SessionInput.Item>(),
    // Transitional mirrors retained while old PromptAdmitted rows/consumers
    // coexist with the generalized inbox. They are not the new authority.
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    provenance: text({ mode: "json" }).$type<SessionMessage.Provenance>(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    revoked_seq: integer(),
    revoked_reason: text().$type<SessionInput.RevocationReason>(),
    /**
     * Sequence of the InputCompleted event that proved this exact input ran a
     * successful provider cycle. Nullable with no default so pre-migration rows
     * stay honestly "never proven complete".
     */
    completed_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_class_delivery_seq_idx")
      .on(table.session_id, table.admission_class, table.delivery, table.admitted_seq)
      .where(sql`${table.promoted_seq} IS NULL AND ${table.revoked_seq} IS NULL`),
    index("session_input_session_latest_user_idx")
      .on(table.session_id, table.admitted_seq)
      .where(sql`${table.kind} = 'user' AND ${table.admission_class} = 'user'`),
    index("session_input_session_preemptible_seq_idx")
      .on(table.session_id, table.admitted_seq)
      .where(
        sql`${table.user_preemptible} = 1 AND ${table.promoted_seq} IS NULL AND ${table.revoked_seq} IS NULL`,
      ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  // Lazy migration: existing rows may still contain the pre-SystemSurface typed
  // snapshot until that Session is prepared once under the new epoch engine.
  snapshot: text({ mode: "json" })
    .notNull()
    .$type<SessionContextEpochState.Checkpoint | SystemContext.LegacySnapshot>(),
  baseline_seq: integer().notNull(),
})

// Single-row backfill cursor for the session_message_fts index: rowid
// high-watermark of messages whose search_text still needs computing.
export const SearchBackfillTable = sqliteTable("search_backfill", {
  id: integer().primaryKey(),
  watermark_rowid: integer().notNull().default(-1),
  done: integer().notNull().default(0),
})

// Single-row backfill cursor for the part_fts (V1) index: rowid
// high-watermark of parts whose search_text still needs computing.
export const PartSearchBackfillTable = sqliteTable("part_search_backfill", {
  id: integer().primaryKey(),
  watermark_rowid: integer().notNull().default(-1),
  done: integer().notNull().default(0),
})

export const SessionCheckpointTable = sqliteTable(
  "session_checkpoint",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    before_snapshot: text(),
    after_snapshot: text(),
    user_message_id: text(),
    assistant_message_id: text(),
    diff: text({ mode: "json" }).$type<readonly Revert.FileDiff[] | null>(),
    additions: integer().notNull().default(0),
    deletions: integer().notNull().default(0),
    files: integer().notNull().default(0),
    excluded: text({ mode: "json" }).$type<readonly { path: string; reason: string; size?: number }[] | null>(),
    error: text({ mode: "json" }).$type<{ code: string; message: string } | null>(),
    epoch: text().notNull(),
    epoch_mismatch: integer().notNull().default(0),
    created_at: integer().notNull(),
    finalized_at: integer(),
  },
  (table) => [
    index("session_checkpoint_session_id_idx").on(table.session_id),
    // Ordinals are the durable, monotonic checkpoint identity within a session.
    // Keep the database invariant aligned with SessionCheckpoint's contract and
    // the original migration: a retry may reconcile an existing checkpoint, but
    // it must never create a second row for the same ordinal.
    uniqueIndex("session_checkpoint_session_ordinal_idx").on(table.session_id, table.ordinal),
    uniqueIndex("session_checkpoint_session_user_message_idx").on(table.session_id, table.user_message_id),
    index("session_checkpoint_epoch_created_idx").on(table.epoch, table.created_at),
  ],
)

/**
 * Compact search projection for checkpoint file paths.
 *
 * The authoritative checkpoint diff remains SessionCheckpointTable.diff. This
 * row stores only newline-joined paths so search never scans cached patch
 * bodies. A supplemental trigram FTS table + storage triggers maintain it for
 * every checkpoint producer (V1 and current/Core).
 */
export const SessionCheckpointSearchTable = sqliteTable(
  "session_checkpoint_search",
  {
    checkpoint_id: text()
      .notNull()
      .references(() => SessionCheckpointTable.id, { onDelete: "cascade" }),
    paths: text().notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.checkpoint_id] })],
)

// ── Conversation Control: Context State Overlay ─────────────────────
// Fork-owned tables. See FORK.md — these are fork-owned, never upstream.

export const SessionContextStateTable = sqliteTable(
  "session_context_state",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<MessageID>().notNull(),
    excluded: integer({ mode: "boolean" }).notNull().default(false),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    override_data: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
    override_search_text: text(),
    modified_seq: integer(),
    modified_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.message_id] }),
    index("session_context_state_session_idx").on(table.session_id),
  ],
)

export const SessionContextOpsTable = sqliteTable(
  "session_context_ops",
  {
    // Keep NOT NULL explicit in generated SQLite. Drizzle elides NOT NULL for a
    // column-level TEXT PRIMARY KEY, but SQLite permits NULL in that form. The
    // historical migration correctly created PRIMARY KEY NOT NULL, so use a
    // table-level PK to make fresh installs preserve the same invariant.
    id: text().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    batch_id: text().notNull(),
    operations: text({ mode: "json" }).$type<unknown[]>().notNull(),
    timestamp: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("session_context_ops_session_idx").on(table.session_id),
    index("session_context_ops_session_time_idx").on(table.session_id, table.timestamp),
  ],
)

export const SessionForkOriginTable = sqliteTable(
  "session_fork_origin",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text().$type<SessionSchema.ID>().notNull(),
    source_message_id: text().$type<MessageID>(),
    source_seq: integer(),
    edge: text().$type<"before" | "after">(),
    kind: text().$type<"manual" | "regenerate" | "temporary" | "model-comparison">().notNull(),
    workspace_mode: text().$type<"shared-current" | "new-worktree">().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id] }),
    index("session_fork_origin_parent_idx").on(table.parent_session_id),
  ],
)
