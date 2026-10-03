import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930062156_session_directory_root_archived_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_archived_id_idx\` ON \`session\` (\`directory\`,\`time_archived\`,\`id\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
