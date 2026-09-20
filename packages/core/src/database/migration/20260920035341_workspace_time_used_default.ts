import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920035341_workspace_time_used_default",
  up(tx) {
    return Effect.gen(function* () {
      // SQLite ignores PRAGMA foreign_keys=OFF inside the transaction that owns
      // a migration. goal.workspace_id and swarm.workspace_id both reference
      // workspace with ON DELETE SET NULL, so a naive Drizzle table rebuild
      // would silently erase those associations when it drops the old parent.
      // Preserve and restore the child references explicitly.
      yield* tx.run(`
        CREATE TEMP TABLE "__workspace_goal_ref" AS
        SELECT "id", "workspace_id"
        FROM "goal"
        WHERE "workspace_id" IS NOT NULL;
      `)
      yield* tx.run(`
        CREATE TEMP TABLE "__workspace_swarm_ref" AS
        SELECT "id", "workspace_id"
        FROM "swarm"
        WHERE "workspace_id" IS NOT NULL;
      `)
      yield* tx.run(`
        CREATE TABLE \`__new_workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_workspace\`(\`id\`, \`type\`, \`name\`, \`branch\`, \`directory\`, \`extra\`, \`project_id\`, \`time_used\`) SELECT \`id\`, \`type\`, \`name\`, \`branch\`, \`directory\`, \`extra\`, \`project_id\`, \`time_used\` FROM \`workspace\`;`,
      )
      yield* tx.run(`DROP TABLE \`workspace\`;`)
      yield* tx.run(`ALTER TABLE \`__new_workspace\` RENAME TO \`workspace\`;`)
      yield* tx.run(`
        UPDATE "goal"
        SET "workspace_id" = (
          SELECT ref."workspace_id"
          FROM "__workspace_goal_ref" AS ref
          WHERE ref."id" = "goal"."id"
        )
        WHERE "id" IN (SELECT "id" FROM "__workspace_goal_ref");
      `)
      yield* tx.run(`
        UPDATE "swarm"
        SET "workspace_id" = (
          SELECT ref."workspace_id"
          FROM "__workspace_swarm_ref" AS ref
          WHERE ref."id" = "swarm"."id"
        )
        WHERE "id" IN (SELECT "id" FROM "__workspace_swarm_ref");
      `)
      yield* tx.run(`DROP TABLE "__workspace_goal_ref";`)
      yield* tx.run(`DROP TABLE "__workspace_swarm_ref";`)
    })
  },
} satisfies DatabaseMigration.Migration
