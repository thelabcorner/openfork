import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Generalize the current Session inbox without rebuilding it underneath the
 * concurrent provenance rollout. `input` becomes the canonical tagged payload;
 * prompt/provenance remain temporary compatibility mirrors until every legacy
 * producer has cut over.
 */
export default {
  id: "20260919043000_session_input_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`kind\` text DEFAULT 'user' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`admission_class\` text DEFAULT 'user' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`user_preemptible\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`input\` text;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`revoked_seq\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`revoked_reason\` text;`)

      // Every pre-generalization row came through PromptAdmitted. Preserve its
      // exact Prompt bytes inside the tagged compatibility item. Host-owned
      // prompt rows keep host execution priority until their producer is moved
      // to the native Synthetic event family.
      yield* tx.run(`
        UPDATE \`session_input\`
        SET
          \`input\` = '{"type":"user","prompt":' || \`prompt\` || '}',
          \`admission_class\` =
            CASE
              WHEN json_extract(\`provenance\`, '$.owner') = 'host' THEN 'host'
              ELSE 'user'
            END
        WHERE \`input\` IS NULL;
      `)

      yield* tx.run(`DROP INDEX IF EXISTS \`session_input_session_pending_delivery_seq_idx\`;`)
      yield* tx.run(`
        CREATE INDEX \`session_input_session_pending_class_delivery_seq_idx\`
        ON \`session_input\` (\`session_id\`, \`admission_class\`, \`delivery\`, \`admitted_seq\`)
        WHERE \`promoted_seq\` IS NULL AND \`revoked_seq\` IS NULL;
      `)
      yield* tx.run(`
        CREATE INDEX \`session_input_session_latest_user_idx\`
        ON \`session_input\` (\`session_id\`, \`admitted_seq\`)
        WHERE \`kind\` = 'user' AND \`admission_class\` = 'user';
      `)
      yield* tx.run(`
        CREATE INDEX \`session_input_session_preemptible_seq_idx\`
        ON \`session_input\` (\`session_id\`, \`admitted_seq\`)
        WHERE \`user_preemptible\` = 1
          AND \`promoted_seq\` IS NULL
          AND \`revoked_seq\` IS NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
