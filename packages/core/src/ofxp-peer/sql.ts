import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import * as DatabasePath from "../database/path"

/** Durable cryptographic peer trust. Endpoint/reachability is deliberately not stored here. */
export const OfxpPeerTable = sqliteTable(
  "ofxp_peer",
  {
    id: text().$type<Ofxp.PeerID>().primaryKey(),
    realm_id: text().notNull(),
    label: text().notNull(),
    public_key_spki: text().notNull(),
    public_key_fingerprint: text().$type<Ofxp.PublicKeyFingerprint>().notNull(),
    rekey_state: text().$type<Ofxp.RekeyState>().notNull().default("stable"),
    paired_at: integer().notNull(),
    last_seen_at: integer(),
    revoked_at: integer(),
    authority_epoch: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("ofxp_peer_fingerprint_idx").on(table.public_key_fingerprint),
    index("ofxp_peer_active_seen_idx").on(table.revoked_at, table.last_seen_at, table.id),
  ],
)

/** Directional Machine-B authority granted to one paired peer. */
export const OfxpPeerGrantTable = sqliteTable(
  "ofxp_peer_grant",
  {
    peer_id: text()
      .$type<Ofxp.PeerID>()
      .primaryKey()
      .references(() => OfxpPeerTable.id, { onDelete: "cascade" }),
    revision: integer().notNull().default(1),
    grant: text({ mode: "json" }).$type<Ofxp.Grant>().notNull(),
    expires_at: integer(),
    time_updated: integer().notNull(),
  },
  (table) => [check("ofxp_peer_grant_revision_positive", sql`${table.revision} >= 1`)],
)

/** Per-peer approved location metadata. Remote callers receive only root id/alias. */
export const OfxpPeerRootTable = sqliteTable(
  "ofxp_peer_root",
  {
    peer_id: text()
      .$type<Ofxp.PeerID>()
      .notNull()
      .references(() => OfxpPeerTable.id, { onDelete: "cascade" }),
    root_id: text().$type<Ofxp.RootID>().notNull(),
    alias: text().$type<Ofxp.RootAlias>().notNull(),
    canonical_path: DatabasePath.absoluteColumn().notNull(),
    identity_fingerprint: text(),
    source: text().$type<"manual" | "project">().notNull().default("manual"),
    approved_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.peer_id, table.root_id] }),
    uniqueIndex("ofxp_peer_root_alias_idx").on(table.peer_id, table.alias),
    index("ofxp_peer_root_path_idx").on(table.peer_id, table.canonical_path),
  ],
)

