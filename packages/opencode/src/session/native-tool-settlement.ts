import type { Database } from "@opencode-ai/core/database/database"
import { NativeToolSettlementTable } from "@opencode-ai/core/session/native-tool-settlement.sql"
import { Effect } from "effect"

export type Status = typeof NativeToolSettlementTable.$inferInsert["status"]
export type Settlement = typeof NativeToolSettlementTable.$inferInsert

/** One atomic, replay-safe SQLite statement per terminal host invocation. */
export const record = (database: Database.Interface, settlement: Settlement) =>
  database.db.insert(NativeToolSettlementTable).values(settlement).onConflictDoNothing().run().pipe(Effect.asVoid)

export * as NativeToolSettlement from "./native-tool-settlement"
