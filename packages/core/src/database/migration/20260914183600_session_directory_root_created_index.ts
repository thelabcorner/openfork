import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914183600_session_directory_root_created_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_created_id_idx\` ON \`session\` (\`directory\`,\`time_created\`,\`id\`) WHERE ("session"."parent_id" is null);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
