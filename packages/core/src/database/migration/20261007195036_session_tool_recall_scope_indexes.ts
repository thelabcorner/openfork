import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007195036_session_tool_recall_scope_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_tool_recall_session_idx\`;`)
      // Fresh-schema databases already have this durable-location index;
      // upgraded databases may not. Both paths must replay safely.
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_directory_idx\` ON \`session\` (\`directory\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_tool_recall_session_tool_time_idx\` ON \`session_tool_recall\` (\`session_id\`,\`tool\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
