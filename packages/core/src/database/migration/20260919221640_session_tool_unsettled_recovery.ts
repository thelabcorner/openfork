import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919221640_session_tool_unsettled_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_message_tool_overlay_unsettled_idx\` ON \`session_message_tool_overlay\` (\`message_id\`,\`call_id\`) WHERE ("session_message_tool_overlay"."settlement_event_id" is null);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
