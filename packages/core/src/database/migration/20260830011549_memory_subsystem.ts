import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260830011549_memory_subsystem",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_anchor\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`value\` text NOT NULL,
          \`normalized\` text NOT NULL,
          CONSTRAINT \`fk_memory_anchor_memory_id_memory_entry_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_entry\` (
          \`id\` text PRIMARY KEY,
          \`topic_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`kind\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`stable_key\` text,
          \`title\` text NOT NULL,
          \`content\` text NOT NULL,
          \`search_text\` text DEFAULT '' NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`valid_from\` integer NOT NULL,
          \`valid_to\` integer,
          \`supersedes_id\` text,
          \`superseded_by_id\` text,
          \`content_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_last_used\` integer,
          \`use_count\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_memory_entry_topic_id_memory_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`memory_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_evidence\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`source_type\` text NOT NULL,
          \`session_id\` text,
          \`message_id\` text,
          \`part_id\` text,
          \`commit_sha\` text,
          \`path\` text,
          \`line_start\` integer,
          \`line_end\` integer,
          \`source_hash\` text,
          \`observed_at\` integer NOT NULL,
          \`excerpt\` text,
          CONSTRAINT \`fk_memory_evidence_memory_id_memory_entry_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_ingest\` (
          \`session_id\` text PRIMARY KEY,
          \`last_ingested_seq\` integer DEFAULT 0 NOT NULL,
          \`target_seq\` integer,
          \`status\` text NOT NULL,
          \`retries\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`time_started\` integer,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_suppression\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`content_hash\` text,
          \`memory_id\` text,
          \`reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_topic\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`key\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text NOT NULL,
          \`projection\` text,
          \`projection_version\` integer DEFAULT 0 NOT NULL,
          \`projection_dirty\` integer DEFAULT 1 NOT NULL,
          \`pinned\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_anchor_normalized_idx\` ON \`memory_anchor\` (\`normalized\`);`)
      yield* tx.run(`CREATE INDEX \`memory_anchor_kind_value_idx\` ON \`memory_anchor\` (\`kind\`,\`value\`);`)
      yield* tx.run(`CREATE INDEX \`memory_anchor_memory_idx\` ON \`memory_anchor\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_entry_topic_idx\` ON \`memory_entry\` (\`topic_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entry_scope_idx\` ON \`memory_entry\` (\`scope\`,\`project_id\`,\`workspace_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_entry_status_idx\` ON \`memory_entry\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entry_stable_key_idx\` ON \`memory_entry\` (\`scope\`,\`project_id\`,\`stable_key\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_entry_content_hash_idx\` ON \`memory_entry\` (\`scope\`,\`content_hash\`);`)
      yield* tx.run(`CREATE INDEX \`memory_entry_time_updated_idx\` ON \`memory_entry\` (\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_evidence_memory_idx\` ON \`memory_evidence\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_evidence_session_idx\` ON \`memory_evidence\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_ingest_status_idx\` ON \`memory_ingest\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_suppression_hash_idx\` ON \`memory_suppression\` (\`scope\`,\`content_hash\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_suppression_memory_idx\` ON \`memory_suppression\` (\`memory_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_topic_scope_key_idx\` ON \`memory_topic\` (\`scope\`,\`project_id\`,\`workspace_id\`,\`key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_topic_project_idx\` ON \`memory_topic\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_topic_workspace_idx\` ON \`memory_topic\` (\`workspace_id\`);`)
    })
  },
  // The FTS5 virtual table and its sync triggers are invisible to drizzle-kit,
  // so the generated full schema cannot create them and a fresh database would
  // never gain them. reconcile() runs on every open and is fully idempotent, so
  // it covers fresh databases AND repairs databases whose journal already
  // claims this migration.
  reconcile(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`memory_entry_fts\` USING fts5(
          title,
          content,
          search_text,
          content='memory_entry',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_fts_ai\` AFTER INSERT ON \`memory_entry\` BEGIN
          INSERT INTO \`memory_entry_fts\`(rowid, title, content, search_text)
          VALUES (new.rowid, new.title, new.content, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_fts_ad\` AFTER DELETE ON \`memory_entry\` BEGIN
          INSERT INTO \`memory_entry_fts\`(\`memory_entry_fts\`, rowid, title, content, search_text)
          VALUES ('delete', old.rowid, old.title, old.content, old.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_fts_au\` AFTER UPDATE ON \`memory_entry\` BEGIN
          INSERT INTO \`memory_entry_fts\`(\`memory_entry_fts\`, rowid, title, content, search_text)
          VALUES ('delete', old.rowid, old.title, old.content, old.search_text);
          INSERT INTO \`memory_entry_fts\`(rowid, title, content, search_text)
          VALUES (new.rowid, new.title, new.content, new.search_text);
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
