import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907015557_goal_mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal_criterion\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          CONSTRAINT \`fk_goal_criterion_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_event\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`payload\` text DEFAULT '{}' NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_goal_event_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_evidence\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`criterion_id\` text,
          \`step_id\` text,
          \`type\` text NOT NULL,
          \`session_id\` text,
          \`message_id\` text,
          \`checkpoint_id\` text,
          \`path\` text,
          \`commit_sha\` text,
          \`summary\` text NOT NULL,
          \`verdict\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_goal_evidence_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_focus\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`role\` text DEFAULT 'owner' NOT NULL,
          \`focused_at\` integer NOT NULL,
          CONSTRAINT \`fk_goal_focus_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_focus_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_step\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`assigned_session_id\` text,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_goal_step_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_step_assigned_session_id_session_id_fk\` FOREIGN KEY (\`assigned_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`title\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`constraints\` text DEFAULT '[]' NOT NULL,
          \`status\` text DEFAULT 'draft' NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`continuation_policy\` text DEFAULT '{"mode":"manual"}' NOT NULL,
          \`blocker\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_goal_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_criterion_goal_position_idx\` ON \`goal_criterion\` (\`goal_id\`,\`position\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_criterion_goal_status_idx\` ON \`goal_criterion\` (\`goal_id\`,\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_event_goal_seq_idx\` ON \`goal_event\` (\`goal_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`goal_event_goal_created_idx\` ON \`goal_event\` (\`goal_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_evidence_goal_created_idx\` ON \`goal_evidence\` (\`goal_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_evidence_criterion_idx\` ON \`goal_evidence\` (\`criterion_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_evidence_step_idx\` ON \`goal_evidence\` (\`step_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_focus_goal_idx\` ON \`goal_focus\` (\`goal_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_step_goal_position_idx\` ON \`goal_step\` (\`goal_id\`,\`position\`);`)
      yield* tx.run(`CREATE INDEX \`goal_step_goal_status_idx\` ON \`goal_step\` (\`goal_id\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`goal_step_session_idx\` ON \`goal_step\` (\`assigned_session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_project_status_updated_idx\` ON \`goal\` (\`project_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`goal_workspace_status_updated_idx\` ON \`goal\` (\`workspace_id\`,\`status\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
