import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921032422_ofxp_peer_authority_epoch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`ofxp_peer\` ADD \`authority_epoch\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
