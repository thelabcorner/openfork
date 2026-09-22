import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921175050_usage_yield_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`usage_record\` ADD \`base_model_id\` text;`)
      yield* tx.run(`ALTER TABLE \`usage_record\` ADD \`account_id\` text;`)
      // One-time identity materialization for historical rows. Keep raw
      // transport model_id untouched; strip only shared account suffix families.
      yield* tx.run(`
        UPDATE usage_record
        SET
          base_model_id = CASE
            WHEN instr(model_id, '@wb-') > 1
              AND length(substr(model_id, instr(model_id, '@wb-') + 1)) > 3
              AND instr(substr(model_id, instr(model_id, '@wb-') + 1), '@') = 0
              THEN substr(model_id, 1, instr(model_id, '@wb-') - 1)
            WHEN instr(model_id, '@vd-') > 1
              AND length(substr(model_id, instr(model_id, '@vd-') + 1)) > 3
              AND instr(substr(model_id, instr(model_id, '@vd-') + 1), '@') = 0
              THEN substr(model_id, 1, instr(model_id, '@vd-') - 1)
            WHEN instr(model_id, '@zen-') > 1
              AND length(substr(model_id, instr(model_id, '@zen-') + 1)) > 4
              AND instr(substr(model_id, instr(model_id, '@zen-') + 1), '@') = 0
              THEN substr(model_id, 1, instr(model_id, '@zen-') - 1)
            ELSE model_id
          END,
          account_id = CASE
            WHEN instr(model_id, '@wb-') > 1
              AND length(substr(model_id, instr(model_id, '@wb-') + 1)) > 3
              AND instr(substr(model_id, instr(model_id, '@wb-') + 1), '@') = 0
              THEN substr(model_id, instr(model_id, '@wb-') + 1)
            WHEN instr(model_id, '@vd-') > 1
              AND length(substr(model_id, instr(model_id, '@vd-') + 1)) > 3
              AND instr(substr(model_id, instr(model_id, '@vd-') + 1), '@') = 0
              THEN substr(model_id, instr(model_id, '@vd-') + 1)
            WHEN instr(model_id, '@zen-') > 1
              AND length(substr(model_id, instr(model_id, '@zen-') + 1)) > 4
              AND instr(substr(model_id, instr(model_id, '@zen-') + 1), '@') = 0
              THEN substr(model_id, instr(model_id, '@zen-') + 1)
            ELSE NULL
          END
        WHERE base_model_id IS NULL;
      `)
      yield* tx.run(
        `CREATE INDEX \`usage_record_base_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`base_model_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_record_account_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`base_model_id\`,\`account_id\`,\`completed_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
