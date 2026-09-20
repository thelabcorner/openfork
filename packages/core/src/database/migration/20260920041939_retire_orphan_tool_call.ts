import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const expectedColumns = [
  "id",
  "session_id",
  "message_id",
  "tool_name",
  "args_json",
  "status",
  "error_message",
  "token_input",
  "token_output",
  "duration_ms",
  "time_created",
] as const

function sameArray(left: string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Retire the abandoned tool-call audit table proposed in
 * docs/plans/03-comprehensive-plan.md but never adopted by the production
 * schema/writer path.
 *
 * Some development databases received this table out-of-band. Do not treat the
 * name alone as authority to delete it: only remove the exact abandoned shape
 * when it is empty and has no additional indexes/triggers. Any data or shape
 * drift fails closed so a plugin/user-owned table can never be silently erased.
 */
export default {
  id: "20260920041939_retire_orphan_tool_call",
  up(tx) {
    return Effect.gen(function* () {
      const table = yield* tx.get<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_call'",
      )
      if (!table) return

      const count = yield* tx.get<{ count: number }>("SELECT count(*) AS count FROM tool_call")
      if ((count?.count ?? 0) !== 0) {
        return yield* Effect.die(
          new Error(
            "Refusing to retire tool_call: expected abandoned audit table to be empty, found " +
              (count?.count ?? 0) +
              " row(s)",
          ),
        )
      }

      const columns = yield* tx.all<{
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>("PRAGMA table_info('tool_call')")
      const names = columns.map((column) => column.name)
      if (!sameArray(names, expectedColumns)) {
        return yield* Effect.die(
          new Error("Refusing to retire tool_call: unexpected column shape: " + names.join(", ")),
        )
      }

      const byName = new Map(columns.map((column) => [column.name, column]))
      const id = byName.get("id")
      const toolName = byName.get("tool_name")
      const status = byName.get("status")
      const timeCreated = byName.get("time_created")
      if (
        id?.type.toUpperCase() !== "TEXT" ||
        id.pk !== 1 ||
        toolName?.type.toUpperCase() !== "TEXT" ||
        toolName.notnull !== 1 ||
        status?.type.toUpperCase() !== "TEXT" ||
        timeCreated?.type.toUpperCase() !== "INTEGER" ||
        timeCreated.notnull !== 1
      ) {
        return yield* Effect.die(
          new Error("Refusing to retire tool_call: core column invariants do not match abandoned schema"),
        )
      }

      const sql = table.sql?.replaceAll(/\s+/g, " ").toLowerCase() ?? ""
      if (
        !sql.includes("check(status in ('success','error'))") ||
        !sql.includes("time_created integer not null default (unixepoch())")
      ) {
        return yield* Effect.die(
          new Error("Refusing to retire tool_call: table DDL does not match abandoned audit schema"),
        )
      }

      const foreignKeys = yield* tx.all<{
        table: string
        from: string
        to: string
        on_update: string
        on_delete: string
      }>("PRAGMA foreign_key_list('tool_call')")
      const normalizedForeignKeys = foreignKeys
        .map((fk) => fk.from + "->" + fk.table + "." + fk.to + ":" + fk.on_update + ":" + fk.on_delete)
        .sort()
      if (
        !sameArray(normalizedForeignKeys, [
          "message_id->message.id:NO ACTION:NO ACTION",
          "session_id->session.id:NO ACTION:NO ACTION",
        ])
      ) {
        return yield* Effect.die(
          new Error("Refusing to retire tool_call: unexpected foreign-key shape: " + normalizedForeignKeys.join(", ")),
        )
      }

      const indexes = yield* tx.all<{ name: string; origin: string }>("PRAGMA index_list('tool_call')")
      if (indexes.some((index) => index.origin !== "pk")) {
        return yield* Effect.die(new Error("Refusing to retire tool_call: table has non-primary indexes"))
      }
      const triggers = yield* tx.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tool_call'",
      )
      if (triggers.length > 0) {
        return yield* Effect.die(new Error("Refusing to retire tool_call: table has triggers"))
      }

      yield* tx.run('DROP TABLE "tool_call"')
    })
  },
} satisfies DatabaseMigration.Migration
