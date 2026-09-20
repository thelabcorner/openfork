import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920034100_schema_convergence",
  up(tx) {
    return Effect.gen(function* () {
      // event_value is part of the canonical Drizzle schema and the read path can
      // encounter historical $cdbRef values even when the ChunkDB writer is
      // disabled. It therefore belongs to ordinary migration history rather
      // than conditional ensureChunkDB bootstrap.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS "event_value" (
          "aggregate_id" text NOT NULL,
          "value_id" text NOT NULL,
          "sha256" text NOT NULL,
          "raw_len" integer NOT NULL,
          "bytes" blob NOT NULL,
          "refs" integer DEFAULT 1 NOT NULL,
          "time_promoted" integer NOT NULL,
          CONSTRAINT "event_value_pk" PRIMARY KEY("aggregate_id", "value_id")
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS `event_value_agg_sha_idx` ON `event_value` (`aggregate_id`,`sha256`);",
      )

      // 20260820000000 created this index as UNIQUE, but a later Drizzle schema
      // regression described it as a plain index. Fresh databases produced
      // during that interval therefore lost the invariant while upgraded
      // databases retained it. Fail closed if any such database already contains
      // duplicate ordinals; silently choosing a checkpoint would destroy the
      // monotonic timeline contract.
      const duplicate = yield* tx.get<{ session_id: string; ordinal: number; count: number }>(`
        SELECT session_id, ordinal, count(*) AS count
        FROM session_checkpoint
        GROUP BY session_id, ordinal
        HAVING count(*) > 1
        LIMIT 1
      `)
      if (duplicate) {
        return yield* Effect.die(
          new Error(
            `Cannot restore unique checkpoint ordinals: session ${duplicate.session_id} has ${duplicate.count} rows at ordinal ${duplicate.ordinal}`,
          ),
        )
      }
      yield* tx.run("DROP INDEX IF EXISTS `session_checkpoint_session_ordinal_idx`;")
      yield* tx.run(
        "CREATE UNIQUE INDEX `session_checkpoint_session_ordinal_idx` ON `session_checkpoint` (`session_id`,`ordinal`);",
      )
    })
  },
} satisfies DatabaseMigration.Migration
