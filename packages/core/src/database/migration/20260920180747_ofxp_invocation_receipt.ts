import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920180747_ofxp_invocation_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`ofxp_invocation_receipt\` (
          \`invocation_id\` text PRIMARY KEY,
          \`source_peer_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`commit_class\` text NOT NULL,
          \`request_digest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`target_ref\` text,
          \`result_digest\` text,
          \`created_at\` integer NOT NULL,
          \`settled_at\` integer,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_ofxp_invocation_receipt_source_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`source_peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "ofxp_invocation_operation_len" CHECK(length("operation") BETWEEN 1 AND 128)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`ofxp_invocation_peer_created_idx\` ON \`ofxp_invocation_receipt\` (\`source_peer_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`ofxp_invocation_state_created_idx\` ON \`ofxp_invocation_receipt\` (\`state\`,\`created_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
