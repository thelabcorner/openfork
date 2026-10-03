import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"

/**
 * Durable provider-route affinity for one Session and provider affinity domain.
 *
 * This is operational routing state, not accounting history. Deleting the
 * Session cascades the binding; archiving the Session leaves it intact so a
 * resumed Session keeps its route.
 */
export const ProviderRouteBindingTable = sqliteTable(
  "provider_route_binding",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    affinity_domain: text().notNull(),
    provider_id: text().notNull(),
    route_kind: text().$type<"public" | "account">().notNull(),

    // Account-route identity. Public routes must keep these NULL.
    account_id: text(),
    credential_handle: text(),
    mode: text().$type<"concentrate" | "session-round-robin">(),
    pin: text().$type<"hard" | "soft">(),

    // Optimistic-CAS fence. Every successful rebind increments by exactly one.
    route_revision: integer().notNull().default(1),
    assigned_at: integer().notNull(),
    assignment_epoch: integer().notNull(),
    reason: text().$type<"explicit" | "initial" | "failover" | "model-selection">().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.affinity_domain] }),
    index("provider_route_binding_provider_kind_idx").on(table.provider_id, table.route_kind),
    index("provider_route_binding_account_idx").on(table.provider_id, table.account_id),
    index("provider_route_binding_credential_idx").on(table.provider_id, table.credential_handle),
    check("provider_route_binding_affinity_domain_check", sql`length(${table.affinity_domain}) > 0`),
    check("provider_route_binding_provider_id_check", sql`length(${table.provider_id}) > 0`),
    check("provider_route_binding_route_kind_check", sql`${table.route_kind} in ('public', 'account')`),
    check(
      "provider_route_binding_mode_check",
      sql`${table.mode} is null or ${table.mode} in ('concentrate', 'session-round-robin')`,
    ),
    check("provider_route_binding_pin_check", sql`${table.pin} is null or ${table.pin} in ('hard', 'soft')`),
    check(
      "provider_route_binding_reason_check",
      sql`${table.reason} in ('explicit', 'initial', 'failover', 'model-selection')`,
    ),
    check("provider_route_binding_revision_check", sql`${table.route_revision} > 0`),
    check("provider_route_binding_assignment_epoch_check", sql`${table.assignment_epoch} > 0`),
    check("provider_route_binding_assigned_at_check", sql`${table.assigned_at} >= 0`),
    check(
      "provider_route_binding_identity_check",
      sql`(
        ${table.route_kind} = 'public'
        and ${table.account_id} is null
        and ${table.credential_handle} is null
        and ${table.mode} is null
        and ${table.pin} is null
      ) or (
        ${table.route_kind} = 'account'
        and ${table.account_id} is not null
        and length(${table.account_id}) > 0
        and ${table.credential_handle} is not null
        and length(${table.credential_handle}) > 0
      )`,
    ),
  ],
)


/**
 * Durable provider/affinity cursor for provider-neutral Auto account policy.
 *
 * This state is intentionally secret-free. It is mutated only in the same
 * transaction that wins a ProviderRoute bind/rebind so a losing/stale routing
 * attempt cannot advance round-robin ownership.
 */
export const ProviderRoutePolicyCursorTable = sqliteTable(
  "provider_route_policy_cursor",
  {
    provider_id: text().notNull(),
    affinity_domain: text().notNull(),
    epoch: integer().notNull().default(0),
    last_assigned_handle: text(),
  },
  (table) => [
    primaryKey({ columns: [table.provider_id, table.affinity_domain] }),
    check("provider_route_policy_cursor_provider_id_check", sql`length(${table.provider_id}) > 0`),
    check(
      "provider_route_policy_cursor_affinity_domain_check",
      sql`length(${table.affinity_domain}) > 0`,
    ),
    check(
      "provider_route_policy_cursor_epoch_check",
      sql`${table.epoch} >= 0 and ${table.epoch} <= 9007199254740991`,
    ),
    check(
      "provider_route_policy_cursor_last_handle_check",
      sql`${table.last_assigned_handle} is null or length(${table.last_assigned_handle}) > 0`,
    ),
  ],
)

/**
 * Historical account assignment statistics used by P5A-P1.
 *
 * Stable ProviderAccount.accountID is the durable key, not Credential.ID. This
 * preserves assignment history across local credential-row replacement while
 * the remote account identity remains the same. Current active-binding counts
 * are deliberately derived from ProviderRouteBindingTable inside the atomic
 * transaction rather than duplicated here.
 */
export const ProviderRouteAccountStatsTable = sqliteTable(
  "provider_route_account_stats",
  {
    provider_id: text().notNull(),
    affinity_domain: text().notNull(),
    account_id: text().notNull(),
    assignment_count: integer().notNull().default(0),
    last_assigned_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.provider_id, table.affinity_domain, table.account_id] }),
    check("provider_route_account_stats_provider_id_check", sql`length(${table.provider_id}) > 0`),
    check(
      "provider_route_account_stats_affinity_domain_check",
      sql`length(${table.affinity_domain}) > 0`,
    ),
    check("provider_route_account_stats_account_id_check", sql`length(${table.account_id}) > 0`),
    check(
      "provider_route_account_stats_count_check",
      sql`${table.assignment_count} >= 0 and ${table.assignment_count} <= 9007199254740991`,
    ),
    check(
      "provider_route_account_stats_last_assigned_at_check",
      sql`${table.last_assigned_at} is null or (${table.last_assigned_at} >= 0 and ${table.last_assigned_at} <= 9007199254740991)`,
    ),
  ],
)
