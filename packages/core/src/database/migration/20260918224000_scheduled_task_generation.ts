import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

const reconcile = (tx: Transaction) =>
  Effect.gen(function* () {
    yield* tx.run(
      "INSERT OR IGNORE INTO scheduled_task_control (id, paused, time_updated, generation) VALUES ('global', false, 0, 0);",
    )

    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_generation_insert AFTER INSERT ON scheduled_task BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_generation_update AFTER UPDATE ON scheduled_task BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_generation_delete AFTER DELETE ON scheduled_task BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )

    // Manual queued work is intentionally independent of next_run_at. This
    // trigger makes a post-commit writer crash observable by a peer even when
    // every task is disabled and no recurrence cursor exists.
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_run_generation_queued_insert AFTER INSERT ON scheduled_task_run WHEN NEW.status = 'queued' BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_run_generation_queued_update AFTER UPDATE OF status ON scheduled_task_run WHEN NEW.status = 'queued' AND OLD.status != 'queued' BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )

    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_control_generation_insert AFTER INSERT ON scheduled_task_control WHEN NEW.id = 'global' BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS scheduled_task_control_generation_paused AFTER UPDATE OF paused ON scheduled_task_control WHEN OLD.paused != NEW.paused BEGIN UPDATE scheduled_task_control SET generation = generation + 1 WHERE id = 'global'; END;",
    )
  })

/**
 * Cross-process scheduler liveness epoch.
 *
 * SQLite is the source of truth for runnable work, so the invalidation token
 * advances in the SAME transaction that mutates that truth. Triggers keep the
 * invariant centralized: future mutation paths cannot forget the epoch bump
 * merely because a TypeScript caller forgot a side effect.
 */
export default {
  id: "20260918224000_scheduled_task_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE scheduled_task_control ADD COLUMN generation integer DEFAULT 0 NOT NULL;")
      yield* reconcile(tx)
    })
  },
  reconcile,
} satisfies DatabaseMigration.Migration
