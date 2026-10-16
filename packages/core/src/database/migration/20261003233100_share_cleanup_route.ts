import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003233100_share_cleanup_route",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`delete_base_url\` text;`)
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`delete_api_family\` text;`)
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`delete_account_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`delete_org_id\` text;`)
      yield* tx.run(`ALTER TABLE \`share_cleanup\` ADD \`base_url\` text;`)
      yield* tx.run(`ALTER TABLE \`share_cleanup\` ADD \`api_family\` text;`)
      yield* tx.run(`ALTER TABLE \`share_cleanup\` ADD \`account_id\` text;`)
      yield* tx.run(`ALTER TABLE \`share_cleanup\` ADD \`org_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
