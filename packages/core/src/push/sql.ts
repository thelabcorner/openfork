import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { PushSubscription } from "@opencode-ai/schema/push-subscription"

// Endpoint/keys are secret capability material (MDN warns possession of the
// endpoint can enable abuse) — never logged in plaintext.
export const PushSubscriptionTable = sqliteTable("push_subscription", {
  id: text().$type<PushSubscription.ID>().primaryKey(),
  endpoint: text().notNull().unique(),
  p256dh: text().notNull(),
  auth: text().notNull(),
  expiration_time: integer(),
  user_agent_hint: text(),
  created_at: integer().notNull(),
  last_seen_at: integer().notNull(),
})

// Single row (id = "default"): one long-lived VAPID key pair per server
// deployment. Private key never leaves this table / the sender module.
export const PushVapidKeyTable = sqliteTable("push_vapid_key", {
  id: text().primaryKey(),
  public_key: text().notNull(),
  private_key: text().notNull(),
  created_at: integer().notNull(),
})
