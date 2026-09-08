import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908070820_session_group_plugin_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_group\` ADD \`owner_ref\` text;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_group_anchor_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_group_subagent_anchor_idx\` ON \`session_group\` (\`kind\`,\`anchor_session_id\`) WHERE "session_group"."kind" = 'subagent' AND "session_group"."anchor_session_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_group_plugin_owner_ref_idx\` ON \`session_group\` (\`kind\`,\`owner_plugin\`,\`owner_ref\`) WHERE "session_group"."kind" = 'plugin' AND "session_group"."owner_plugin" IS NOT NULL AND "session_group"."owner_ref" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
