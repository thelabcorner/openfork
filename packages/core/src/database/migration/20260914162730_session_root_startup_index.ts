import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914162730_session_root_startup_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_project_directory_root_updated_idx\` ON \`session\` (\`project_id\`,\`directory\`,\`time_updated\`) WHERE ("session"."parent_id" is null);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
