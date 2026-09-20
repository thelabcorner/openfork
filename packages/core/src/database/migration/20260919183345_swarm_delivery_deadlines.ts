import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919183345_swarm_delivery_deadlines",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`swarm_message_expiry_idx\` ON \`swarm_message\` (\`expires_at\`,\`id\`) WHERE "swarm_message"."expires_at" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
