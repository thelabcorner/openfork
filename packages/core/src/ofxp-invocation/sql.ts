import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpPeerTable } from "../ofxp-peer/sql"

export const OfxpInvocationReceiptTable = sqliteTable(
  "ofxp_invocation_receipt",
  {
    invocation_id: text().$type<Ofxp.InvocationID>().primaryKey(),
    source_peer_id: text()
      .$type<Ofxp.PeerID>()
      .notNull()
      .references(() => OfxpPeerTable.id, { onDelete: "cascade" }),
    operation: text().notNull(),
    commit_class: text().$type<Ofxp.CommitClass>().notNull(),
    request_digest: text().notNull(),
    state: text().$type<Ofxp.ReceiptState>().notNull(),
    target_ref: text(),
    result_digest: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("ofxp_invocation_peer_created_idx").on(table.source_peer_id, table.created_at),
    index("ofxp_invocation_state_created_idx").on(table.state, table.created_at),
    check("ofxp_invocation_operation_len", sql`length(${table.operation}) BETWEEN 1 AND 128`),
  ],
)

