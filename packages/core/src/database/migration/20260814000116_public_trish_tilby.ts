import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814000116_public_trish_tilby",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (columns.some((column) => column.name === "paused_at")) return
      yield* tx.run(`ALTER TABLE \`session\` ADD \`paused_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
