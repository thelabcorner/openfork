import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010074926_context-part-facts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_projection_version\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_kind\` text;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_tokens\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_preview\` text;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_signed\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_status\` text;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_synthetic\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_ignored\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
