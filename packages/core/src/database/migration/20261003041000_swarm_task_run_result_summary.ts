import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Bounded worker-authored result for one exact Swarm task run.
 *
 * Nullable with no default: historical runs predate result-summary persistence
 * and must remain honestly "no durable result summary" rather than inheriting a
 * fabricated value. Core bounds new values before writing this column.
 */
export default {
  id: "20261003041000_swarm_task_run_result_summary",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`swarm_task_run\` ADD \`result_summary\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
