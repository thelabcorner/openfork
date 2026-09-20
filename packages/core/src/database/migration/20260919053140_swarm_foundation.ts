import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/** First-party Swarm durable specification/current-state tables. Event history remains in EventV2. */
export default {
  id: "20260919053140_swarm_foundation",
  up(tx) {
    return Effect.gen(function* () {
      const leakedBlackboard = yield* tx.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_blackboard'`,
      )
      if (leakedBlackboard) {
        const ownershipMigration = yield* tx.get<{ id: string }>(
          `SELECT id FROM migration WHERE id = '20260919052438_runtime_session_ownership'`,
        )
        const messageColumns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`swarm_message\`)`)
        const leakedByOwnershipMigration =
          ownershipMigration !== undefined &&
          messageColumns.length > 0 &&
          !messageColumns.some((column) => column.name === "sender_session_id")

        if (!leakedByOwnershipMigration) {
          return yield* Effect.die(
            new Error("swarm foundation tables already exist outside the known runtime-ownership migration overlap"),
          )
        }

        // A pre-release generator race briefly emitted the Swarm foundation into
        // the immediately preceding runtime-ownership migration. That migration
        // commits before this one starts, so affected databases can reach this
        // point with the old Swarm shape journaled and this migration pending.
        // Never discard rows: only self-heal the empty, startup-blocking shape.
        const leakedTables = [
          "swarm_message_delivery",
          "swarm_blackboard",
          "swarm_claim",
          "swarm_task_dependency",
          "swarm_task_lease",
          "swarm_task_run",
          "swarm_message",
          "swarm_task",
          "swarm_member",
          "swarm",
        ] as const
        for (const table of leakedTables) {
          const exists = yield* tx.get<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
          )
          if (!exists) continue
          const occupied = yield* tx.get<{ occupied: number }>(
            `SELECT EXISTS(SELECT 1 FROM \`${table}\` LIMIT 1) AS occupied`,
          )
          if (occupied?.occupied) {
            return yield* Effect.die(
              new Error(
                `cannot repair leaked Swarm foundation: ${table} contains rows; refusing to discard durable data`,
              ),
            )
          }
        }
        for (const table of leakedTables) {
          yield* tx.run(`DROP TABLE IF EXISTS \`${table}\``)
        }
      }

      yield* tx.run(`CREATE TABLE \`swarm_blackboard\` (
	\`swarm_id\` text NOT NULL,
	\`key\` text NOT NULL,
	\`value\` text NOT NULL,
	\`content_type\` text NOT NULL,
	\`version\` integer DEFAULT 0 NOT NULL,
	\`author_member_id\` text NOT NULL,
	\`task_id\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	CONSTRAINT \`swarm_blackboard_pk\` PRIMARY KEY(\`swarm_id\`, \`key\`),
	CONSTRAINT \`fk_swarm_blackboard_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_blackboard_author_member_id_swarm_member_id_fk\` FOREIGN KEY (\`author_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm_claim\` (
	\`swarm_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`scope\` text NOT NULL,
	\`generation\` integer DEFAULT 0 NOT NULL,
	\`expires_at\` integer,
	\`released_at\` integer,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	CONSTRAINT \`swarm_claim_pk\` PRIMARY KEY(\`swarm_id\`, \`member_id\`, \`scope\`),
	CONSTRAINT \`fk_swarm_claim_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_claim_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm_member\` (
	\`id\` text PRIMARY KEY,
	\`swarm_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`role\` text NOT NULL,
	\`lifecycle\` text DEFAULT 'active' NOT NULL,
	\`session_id\` text,
	\`binding_generation\` integer DEFAULT 0 NOT NULL,
	\`desired_profile\` text,
	\`workspace_policy\` text NOT NULL,
	\`capabilities\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_stopped\` integer,
	CONSTRAINT \`fk_swarm_member_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
);`)
      yield* tx.run(`CREATE TABLE \`swarm_message_delivery\` (
	\`id\` text PRIMARY KEY,
	\`message_id\` text NOT NULL,
	\`recipient_member_id\` text NOT NULL,
	\`state\` text DEFAULT 'pending' NOT NULL,
	\`session_input_id\` text NOT NULL,
	\`claim_generation\` integer DEFAULT 0 NOT NULL,
	\`claim_owner\` text,
	\`claim_expires_at\` integer,
	\`next_attempt_at\` integer,
	\`attempt_count\` integer DEFAULT 0 NOT NULL,
	\`admitted_session_id\` text,
	\`admitted_seq\` integer,
	\`admitted_at\` integer,
	\`error\` text,
	\`time_created\` integer NOT NULL,
	CONSTRAINT \`fk_swarm_message_delivery_message_id_swarm_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`swarm_message\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_message_delivery_recipient_member_id_swarm_member_id_fk\` FOREIGN KEY (\`recipient_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm_message\` (
	\`id\` text PRIMARY KEY,
	\`swarm_id\` text NOT NULL,
	\`sender_member_id\` text NOT NULL,
	\`sender_session_id\` text NOT NULL,
	\`sender_binding_generation\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`body\` text NOT NULL,
	\`task_id\` text,
	\`correlation_id\` text,
	\`response_to\` text,
	\`priority\` text DEFAULT 'normal' NOT NULL,
	\`reply_expected\` integer DEFAULT true NOT NULL,
	\`time_created\` integer NOT NULL,
	\`expires_at\` integer,
	CONSTRAINT \`fk_swarm_message_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_message_sender_member_id_swarm_member_id_fk\` FOREIGN KEY (\`sender_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm\` (
	\`id\` text PRIMARY KEY,
	\`project_id\` text NOT NULL,
	\`directory\` text NOT NULL,
	\`workspace_id\` text,
	\`name\` text NOT NULL,
	\`status\` text DEFAULT 'creating' NOT NULL,
	\`coordinator_member_id\` text,
	\`policy\` text DEFAULT '{}' NOT NULL,
	\`revision\` integer DEFAULT 0 NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_completed\` integer,
	\`time_archived\` integer,
	CONSTRAINT \`fk_swarm_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`) ON DELETE SET NULL
);`)
      yield* tx.run(`CREATE TABLE \`swarm_task_dependency\` (
	\`task_id\` text NOT NULL,
	\`depends_on_task_id\` text NOT NULL,
	\`requirement\` text DEFAULT 'require_success' NOT NULL,
	CONSTRAINT \`swarm_task_dependency_pk\` PRIMARY KEY(\`task_id\`, \`depends_on_task_id\`),
	CONSTRAINT \`fk_swarm_task_dependency_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_task_dependency_depends_on_task_id_swarm_task_id_fk\` FOREIGN KEY (\`depends_on_task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT "swarm_task_dependency_no_self_check" CHECK("task_id" != "depends_on_task_id")
);`)
      yield* tx.run(`CREATE TABLE \`swarm_task_lease\` (
	\`task_id\` text PRIMARY KEY,
	\`generation\` integer NOT NULL,
	\`owner_member_id\` text NOT NULL,
	\`owner_session_id\` text NOT NULL,
	\`owner_binding_generation\` integer NOT NULL,
	\`lease_owner_process\` text NOT NULL,
	\`state\` text DEFAULT 'active' NOT NULL,
	\`hold_user_seq\` integer,
	\`hold_started_at\` integer,
	\`hold_deadline\` integer,
	\`retire_reason\` text,
	\`retire_requested_at\` integer,
	\`acquired_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`renewed_at\` integer,
	CONSTRAINT \`fk_swarm_task_lease_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_task_lease_owner_member_id_swarm_member_id_fk\` FOREIGN KEY (\`owner_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm_task_run\` (
	\`id\` text PRIMARY KEY,
	\`task_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`session_id\` text NOT NULL,
	\`binding_generation\` integer NOT NULL,
	\`lease_generation\` integer NOT NULL,
	\`session_input_id\` text NOT NULL,
	\`status\` text NOT NULL,
	\`failure_kind\` text,
	\`failure_detail\` text,
	\`admitted_at\` integer,
	\`started_at\` integer,
	\`ended_at\` integer,
	\`time_created\` integer NOT NULL,
	CONSTRAINT \`fk_swarm_task_run_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_task_run_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`)
);`)
      yield* tx.run(`CREATE TABLE \`swarm_task\` (
	\`id\` text PRIMARY KEY,
	\`swarm_id\` text NOT NULL,
	\`title\` text NOT NULL,
	\`description\` text,
	\`status\` text DEFAULT 'pending' NOT NULL,
	\`priority\` integer DEFAULT 0 NOT NULL,
	\`created_by_member_id\` text,
	\`reserved_member_id\` text,
	\`reserved_until\` integer,
	\`reservation_revision\` integer DEFAULT 0 NOT NULL,
	\`lease_generation\` integer DEFAULT 0 NOT NULL,
	\`semantic_retry_count\` integer DEFAULT 0 NOT NULL,
	\`acceptance\` text DEFAULT '{"criteria":[]}' NOT NULL,
	\`metadata\` text DEFAULT '{}' NOT NULL,
	\`ready_at\` integer,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_completed\` integer,
	CONSTRAINT \`fk_swarm_task_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE
);`)
      yield* tx.run(`CREATE TABLE \`swarm_deliverable\` (
	\`id\` text PRIMARY KEY,
	\`swarm_id\` text NOT NULL,
	\`member_id\` text NOT NULL,
	\`task_run_id\` text,
	\`summary\` text NOT NULL,
	\`refs\` text DEFAULT '[]' NOT NULL,
	\`files\` text DEFAULT '[]' NOT NULL,
	\`verdict\` text,
	\`verdict_by_member_id\` text,
	\`time_created\` integer NOT NULL,
	\`verdict_at\` integer,
	CONSTRAINT \`fk_swarm_deliverable_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_swarm_deliverable_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`),
	CONSTRAINT \`fk_swarm_deliverable_task_run_id_swarm_task_run_id_fk\` FOREIGN KEY (\`task_run_id\`) REFERENCES \`swarm_task_run\`(\`id\`)
);`)
      yield* tx.run(`CREATE INDEX \`swarm_blackboard_task_idx\` ON \`swarm_blackboard\` (\`swarm_id\`,\`task_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_claim_expiry_idx\` ON \`swarm_claim\` (\`expires_at\`,\`swarm_id\`,\`member_id\`) WHERE "swarm_claim"."released_at" IS NULL AND "swarm_claim"."expires_at" IS NOT NULL;`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`swarm_member_name_idx\` ON \`swarm_member\` (\`swarm_id\`,\`name\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_member_bound_session_idx\` ON \`swarm_member\` (\`swarm_id\`,\`session_id\`) WHERE "swarm_member"."session_id" IS NOT NULL;`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_member_session_idx\` ON \`swarm_member\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_member_roster_idx\` ON \`swarm_member\` (\`swarm_id\`,\`lifecycle\`,\`kind\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_message_delivery_recipient_idx\` ON \`swarm_message_delivery\` (\`message_id\`,\`recipient_member_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_message_delivery_input_idx\` ON \`swarm_message_delivery\` (\`session_input_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_recipient_pending_idx\` ON \`swarm_message_delivery\` (\`recipient_member_id\`,\`time_created\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'pending';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_due_idx\` ON \`swarm_message_delivery\` (\`next_attempt_at\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'pending';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_claim_expiry_idx\` ON \`swarm_message_delivery\` (\`claim_expires_at\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'claimed';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_stream_idx\` ON \`swarm_message\` (\`swarm_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_correlation_idx\` ON \`swarm_message\` (\`swarm_id\`,\`correlation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_project_status_updated_idx\` ON \`swarm\` (\`project_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_workspace_idx\` ON \`swarm\` (\`workspace_id\`,\`status\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_dependency_reverse_idx\` ON \`swarm_task_dependency\` (\`depends_on_task_id\`,\`task_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_task_lease_due_idx\` ON \`swarm_task_lease\` (\`expires_at\`,\`task_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_member_idx\` ON \`swarm_task_lease\` (\`owner_member_id\`,\`task_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`swarm_task_run_input_idx\` ON \`swarm_task_run\` (\`session_input_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_run_task_created_idx\` ON \`swarm_task_run\` (\`task_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_run_member_created_idx\` ON \`swarm_task_run\` (\`member_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_ready_idx\` ON \`swarm_task\` (\`swarm_id\`,\`status\`,"priority" DESC,\`ready_at\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_reserved_member_idx\` ON \`swarm_task\` (\`reserved_member_id\`,\`status\`,\`reserved_until\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_stream_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_member_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`member_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_deliverable_task_run_idx\` ON \`swarm_deliverable\` (\`task_run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_open_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`time_created\`,\`id\`) WHERE "swarm_deliverable"."verdict" IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
