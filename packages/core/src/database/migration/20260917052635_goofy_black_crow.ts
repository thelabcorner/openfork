import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917052635_goofy_black_crow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_control\` (
          \`id\` text PRIMARY KEY,
          \`paused\` integer DEFAULT false NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_lease\` (
          \`task_id\` text PRIMARY KEY,
          \`fire_for\` integer NOT NULL,
          \`lease_id\` text NOT NULL,
          \`owner\` text,
          \`acquired_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`attempt\` integer DEFAULT 1 NOT NULL,
          CONSTRAINT \`fk_scheduled_task_lease_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`fire_for\` integer NOT NULL,
          \`trigger\` text NOT NULL,
          \`status\` text NOT NULL,
          \`session_id\` text,
          \`workspace_id\` text,
          \`directory\` text,
          \`skip_reason\` text,
          \`error_kind\` text,
          \`error_message\` text,
          \`attempt\` integer DEFAULT 1 NOT NULL,
          \`acknowledged_at\` integer,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          CONSTRAINT \`fk_scheduled_task_run_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text,
          \`target_directory\` text NOT NULL,
          \`target\` text NOT NULL,
          \`name\` text NOT NULL,
          \`enabled\` integer DEFAULT false NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`schedule\` text NOT NULL,
          \`timezone\` text,
          \`action\` text NOT NULL,
          \`policy\` text NOT NULL,
          \`next_run_at\` integer,
          \`last_run_at\` integer,
          \`last_run_status\` text,
          \`last_run_id\` text,
          \`consecutive_failures\` integer DEFAULT 0 NOT NULL,
          \`source\` text DEFAULT 'api' NOT NULL,
          \`source_path\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_task_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_lease_id_idx\` ON \`scheduled_task_lease\` (\`lease_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_lease_heartbeat_idx\` ON \`scheduled_task_lease\` (\`heartbeat_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_run_logical_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`fire_for\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_task_started_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`started_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_inbox_idx\` ON \`scheduled_task_run\` (\`acknowledged_at\`,\`started_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`scheduled_task_due_idx\` ON \`scheduled_task\` (\`enabled\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_task_project_idx\` ON \`scheduled_task\` (\`project_id\`,\`name\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_source_path_idx\` ON \`scheduled_task\` (\`source_path\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
