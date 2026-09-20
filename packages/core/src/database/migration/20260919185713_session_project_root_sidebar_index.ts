import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919185713_session_project_root_sidebar_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_project_root_updated_id_idx\` ON \`session\` (\`project_id\`,\`time_updated\`,\`id\`) WHERE ("session"."parent_id" is null);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
