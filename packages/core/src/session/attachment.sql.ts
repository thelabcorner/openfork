import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionAttachment } from "@opencode-ai/schema/session-attachment"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"

/**
 * Immutable content-addressed blob bytes.
 *
 * Content identity is deliberately separate from logical upload identity: two
 * uploads with equal bytes share one blob row while retaining distinct
 * ownership, filenames, grants, and revocation. Possessing or knowing a content
 * hash never grants access.
 *
 * Bytes live inline here (bounded compatibility backing for the first
 * implementation). Reclamation follows the upload tombstone/retention
 * references, never parent-session reachability alone.
 */
export const SessionAttachmentBlobTable = sqliteTable(
  "session_attachment_blob",
  {
    id: text().$type<SessionAttachment.BlobID>().primaryKey(),
    /** Lowercase hex SHA-256 of the raw bytes. Dedup only; never an access fact. */
    content_hash: text().notNull(),
    mime: text().notNull(),
    byte_length: integer().notNull(),
    /** Inline bytes for the first implementation (base64 or data-url payload). */
    bytes: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [uniqueIndex("session_attachment_blob_hash_idx").on(table.content_hash)],
)

/**
 * Logical upload identity owned by a parent Session turn/part.
 *
 * This is the durable causal record showing which upload the user supplied. A
 * user-upload origin is stamped only at the trusted V1 admission boundary;
 * `file://` workspace references, MCP resources, and tool output are never
 * eligible merely because they also lower to a V1 `file` part.
 */
export const SessionAttachmentTable = sqliteTable(
  "session_attachment",
  {
    id: text().$type<SessionAttachment.ID>().primaryKey(),
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().notNull(),
    part_id: text().notNull(),
    blob_id: text()
      .$type<SessionAttachment.BlobID>()
      .notNull()
      .references(() => SessionAttachmentBlobTable.id),
    origin: text().$type<SessionAttachment.Origin>().notNull(),
    filename: text(),
    /** Sniffed/validated MIME; never trusted from the wire alone. */
    mime: text().notNull(),
    byte_length: integer().notNull(),
    /** Stable model-visible handle within the owning Session. */
    handle: text().$type<SessionAttachment.Handle>().notNull(),
    /** Tombstone prevents future reads; bytes are reclaimed by retention. */
    tombstoned_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("session_attachment_handle_idx").on(table.session_id, table.handle),
    uniqueIndex("session_attachment_source_part_idx").on(table.session_id, table.message_id, table.part_id),
    // Explicit paginated session index: O(k) for the returned page, ordered by
    // recency, independent of transcript length.
    index("session_attachment_session_index_idx").on(table.session_id, table.time_created, table.id),
  ],
)

/**
 * Immutable grant edge. One authorization for one exact recipient identity.
 *
 * The idempotency key is tied to a unique delegation invocation or task-run/
 * admission identity, so retries reuse the same grant and never duplicate bytes
 * or grant edges. Revocation cascades to descendant grants; unlinking/deleting a
 * parent Session is not itself source revocation.
 */
export const SessionAttachmentGrantTable = sqliteTable(
  "session_attachment_grant",
  {
    id: text().$type<SessionAttachment.GrantID>().primaryKey(),
    attachment_id: text()
      .$type<SessionAttachment.ID>()
      .notNull()
      .references(() => SessionAttachmentTable.id, { onDelete: "cascade" }),
    /** Snapshot of the owning source session for grant-time validation. */
    source_session_id: text().$type<typeof SessionTable.$inferSelect.id>().notNull(),
    source_message_id: text().notNull(),
    source_part_id: text().notNull(),
    target_kind: text().$type<SessionAttachment.GrantTarget["kind"]>().notNull(),
    /** Target identity columns, populated per `target_kind`. */
    target_child_session_id: text().$type<typeof SessionTable.$inferSelect.id>(),
    target_tool_call_id: text(),
    target_tool_part_id: text(),
    target_assistant_message_id: text(),
    target_task_id: text(),
    target_run_id: text(),
    target_session_input_id: text(),
    target_member_session_id: text().$type<typeof SessionTable.$inferSelect.id>(),
    state: text().$type<SessionAttachment.GrantState>().notNull().default("active"),
    /** Bounded reason/status for revocation, expiry, or tombstone. */
    reason: text(),
    /** Idempotency key: exact delegation invocation or task-run/admission identity. */
    idempotency_key: text().notNull(),
    /** Set when this grant was created by forwarding an ancestor grant. */
    parent_grant_id: text().$type<SessionAttachment.GrantID>(),
    revoked_at: integer(),
    expires_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("session_attachment_grant_idempotency_idx").on(table.idempotency_key),
    index("session_attachment_grant_attachment_idx").on(table.attachment_id, table.state),
    index("session_attachment_grant_target_child_idx").on(table.target_child_session_id, table.state),
    index("session_attachment_grant_target_run_idx").on(table.target_run_id, table.state),
    index("session_attachment_grant_parent_idx").on(table.parent_grant_id),
  ],
)

/**
 * Per-recipient handoff status. Kept as its own row so the four independent
 * facts (selected / authorized / resolved / included) can be recorded
 * incrementally without rewriting the immutable grant edge.
 */
export const SessionAttachmentStatusTable = sqliteTable(
  "session_attachment_status",
  {
    grant_id: text()
      .$type<SessionAttachment.GrantID>()
      .primaryKey()
      .references(() => SessionAttachmentGrantTable.id, { onDelete: "cascade" }),
    selected: integer({ mode: "boolean" }).notNull().default(false),
    authorized: integer({ mode: "boolean" }).notNull().default(false),
    resolved: integer({ mode: "boolean" }).notNull().default(false),
    included_in_provider_request: integer({ mode: "boolean" }).notNull().default(false),
    /** Recipient provider/account/route when it is resolved for inclusion. */
    recipient_provider_id: text(),
    recipient_model_id: text(),
    recipient_account_id: text(),
    reason: text(),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_attachment_status_included_idx")
      .on(table.included_in_provider_request, table.time_updated)
      .where(sql`${table.included_in_provider_request} = 1`),
    index("session_attachment_status_recipient_idx").on(table.recipient_provider_id, table.recipient_model_id),
  ],
)

/** Re-exported timestamp helper for callers that build ad-hoc inserts. */
export { Timestamps as SessionAttachmentTimestamps }
