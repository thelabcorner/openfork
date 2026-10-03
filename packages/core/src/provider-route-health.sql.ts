import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ProviderAccountRouteHealthTable = sqliteTable(
  "provider_account_route_health",
  {
    provider_id: text().notNull(),
    account_id: text().notNull(),
    model_id: text().notNull(),
    state: text().$type<"auth-invalid" | "cooling-down" | "quota-exhausted">().notNull(),
    credential_revision: integer(),
    expires_at: integer(),
    observed_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider_id, table.account_id, table.model_id] }),
    index("provider_account_route_health_expiry_idx").on(table.expires_at),
    check("provider_account_route_health_provider_check", sql`length(${table.provider_id}) > 0`),
    check("provider_account_route_health_account_check", sql`length(${table.account_id}) > 0`),
    check("provider_account_route_health_model_check", sql`length(${table.model_id}) > 0`),
    check(
      "provider_account_route_health_state_check",
      sql`${table.state} in ('auth-invalid', 'cooling-down', 'quota-exhausted')`,
    ),
    check(
      "provider_account_route_health_observed_check",
      sql`${table.observed_at} >= 0 and ${table.observed_at} <= 9007199254740991`,
    ),
    check(
      "provider_account_route_health_shape_check",
      sql`(
        ${table.state} = 'auth-invalid'
        and ${table.credential_revision} is not null
        and ${table.credential_revision} > 0
        and ${table.credential_revision} <= 9007199254740991
        and ${table.expires_at} is null
      ) or (
        ${table.state} in ('cooling-down', 'quota-exhausted')
        and ${table.credential_revision} is null
        and ${table.expires_at} is not null
        and ${table.expires_at} > ${table.observed_at}
        and ${table.expires_at} <= 9007199254740991
      )`,
    ),
  ],
)

export const ProviderPublicRouteHealthTable = sqliteTable(
  "provider_public_route_health",
  {
    provider_id: text().notNull(),
    model_id: text().notNull(),
    state: text().$type<"cooling-down" | "quota-exhausted">().notNull(),
    expires_at: integer().notNull(),
    observed_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider_id, table.model_id] }),
    index("provider_public_route_health_expiry_idx").on(table.expires_at),
    check("provider_public_route_health_provider_check", sql`length(${table.provider_id}) > 0`),
    check("provider_public_route_health_model_check", sql`length(${table.model_id}) > 0`),
    check(
      "provider_public_route_health_state_check",
      sql`${table.state} in ('cooling-down', 'quota-exhausted')`,
    ),
    check(
      "provider_public_route_health_time_check",
      sql`${table.observed_at} >= 0
        and ${table.observed_at} <= 9007199254740991
        and ${table.expires_at} > ${table.observed_at}
        and ${table.expires_at} <= 9007199254740991`,
    ),
  ],
)
