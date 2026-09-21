import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920163326_ofxp_peer_trust",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer_grant\` (
          \`peer_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`grant\` text NOT NULL,
          \`expires_at\` integer,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_ofxp_peer_grant_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "ofxp_peer_grant_revision_positive" CHECK("revision" >= 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer_root\` (
          \`peer_id\` text NOT NULL,
          \`root_id\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`canonical_path\` text NOT NULL,
          \`identity_fingerprint\` text,
          \`source\` text DEFAULT 'manual' NOT NULL,
          \`approved_at\` integer NOT NULL,
          CONSTRAINT \`ofxp_peer_root_pk\` PRIMARY KEY(\`peer_id\`, \`root_id\`),
          CONSTRAINT \`fk_ofxp_peer_root_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer\` (
          \`id\` text PRIMARY KEY,
          \`realm_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`public_key_spki\` text NOT NULL,
          \`public_key_fingerprint\` text NOT NULL,
          \`rekey_state\` text DEFAULT 'stable' NOT NULL,
          \`paired_at\` integer NOT NULL,
          \`last_seen_at\` integer,
          \`revoked_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`ofxp_peer_root_alias_idx\` ON \`ofxp_peer_root\` (\`peer_id\`,\`alias\`);`)
      yield* tx.run(`CREATE INDEX \`ofxp_peer_root_path_idx\` ON \`ofxp_peer_root\` (\`peer_id\`,\`canonical_path\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`ofxp_peer_fingerprint_idx\` ON \`ofxp_peer\` (\`public_key_fingerprint\`);`)
      yield* tx.run(
        `CREATE INDEX \`ofxp_peer_active_seen_idx\` ON \`ofxp_peer\` (\`revoked_at\`,\`last_seen_at\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
