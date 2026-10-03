import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930045443_session_directory_root_updated_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_updated_id_idx\` ON \`session\` (\`directory\`,\`time_updated\`,\`id\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
