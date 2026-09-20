import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Crash-safe mailbox for the latest accepted revision of one editable target.
 *
 * This is deliberately not revision history. The special-agent transcript owns
 * history; this table only bridges the interval between model acceptance and
 * the renderer/editor durably incorporating the result.
 */
export const RevisionDraftTable = sqliteTable(
  "revision_draft",
  {
    id: text().primaryKey(),
    directory: text().notNull(),
    target_kind: text().notNull(),
    target_key: text().notNull(),
    purpose: text().notNull(),
    source_fingerprint: text().notNull(),
    prompt: text().notNull(),
    references: text({ mode: "json" }).$type<readonly unknown[]>().notNull().default([]),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [uniqueIndex("revision_draft_target_idx").on(table.target_kind, table.target_key)],
)

/**
 * Single-writer generation fence for each editable target.
 *
 * A newer request replaces the claim before it starts expensive model work.
 * Completion may commit only while its exact claim is still current, so an
 * older provider call finishing late can never replace a newer generation.
 */
export const RevisionDraftClaimTable = sqliteTable(
  "revision_draft_claim",
  {
    target_kind: text().notNull(),
    target_key: text().notNull(),
    claim_id: text().notNull(),
    source_fingerprint: text().notNull(),
    time_claimed: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.target_kind, table.target_key] })],
)
