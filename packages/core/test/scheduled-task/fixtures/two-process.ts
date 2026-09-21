/**
 * Two-real-process concurrency fixture (T9 C1/C2/C3).
 *
 * Invoked as:
 *   bun test/scheduled-task/fixtures/two-process.ts <dbPath> <startAt> <mode>
 *
 * `mode` is one of:
 *   race     claim -> recordRunStart, print the outcome, exit
 *   hold     claim, then exit WITHOUT settling (simulates a killed runner)
 *   recover  recoverStale with an advanced clock, print reclaimed task ids
 *   queue    enqueue one manual run and print the generation transition
 *
 * Two OS processes over one SQLite file are the only way to prove the lease
 * adjudicates the race: two fibers in one process are serialized by the
 * runtime and would pass even with the guard removed.
 */
import { Duration, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"

const [dbPath, startAtText, mode] = process.argv.slice(2)
if (!dbPath || !startAtText || !mode) {
  console.error("usage: two-process.ts <dbPath> <startAt> <race|hold|recover|queue>")
  process.exit(2)
}
const startAt = Number(startAtText)

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, ScheduledTask.node, ScheduledTaskLease.node]),
  [[Database.node, Database.layerFromPath(dbPath)]],
)

const sleepUntilStart = Effect.suspend(() => Effect.sleep(Duration.millis(Math.max(startAt - Date.now(), 0))))

const seeded = Effect.gen(function* () {
  const tasks = yield* ScheduledTask.Service
  const rows = yield* tasks.list()
  const task = rows[0]
  if (!task || task.nextRunAt === undefined) return yield* Effect.die(new Error("no seeded scheduled_task row"))
  return { taskID: task.id, fireFor: task.nextRunAt }
})

const program = Effect.gen(function* () {
  const tasks = yield* ScheduledTask.Service
  const leases = yield* ScheduledTaskLease.Service

  if (mode === "race") {
    yield* sleepUntilStart
    const { taskID, fireFor } = yield* seeded
    const lease = yield* leases.claim({ taskID, fireFor, now: startAt })
    if (!lease) {
      console.log(JSON.stringify({ claimed: false }))
      return
    }
    const started = yield* tasks.recordRunStart({
      taskID,
      fireFor,
      trigger: "schedule",
      attempt: 1,
      acceptExisting: "none",
      now: startAt,
    })
    console.log(JSON.stringify({ claimed: true, run: started.kind }))
    return
  }

  if (mode === "hold") {
    yield* sleepUntilStart
    const { taskID, fireFor } = yield* seeded
    const lease = yield* leases.claim({ taskID, fireFor, now: startAt })
    if (lease) {
      yield* tasks.recordRunStart({
        taskID,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: startAt,
      })
    }
    console.log(JSON.stringify({ claimed: lease !== undefined }))
    // Exit without settling: heartbeat stops, lease goes stale, run stays running.
    return
  }

  if (mode === "recover") {
    yield* sleepUntilStart
    const reclaimed = yield* leases.recoverStale({ now: startAt + 200_000 })
    console.log(JSON.stringify({ reclaimed: reclaimed.map((item) => item.taskID) }))
    return
  }

  if (mode === "queue") {
    yield* sleepUntilStart
    const rows = yield* tasks.list()
    const task = rows[0]
    if (!task) return yield* Effect.die(new Error("no seeded scheduled_task row"))
    const before = yield* tasks.generation()
    const run = yield* tasks.enqueueManualRun({ taskID: task.id, now: startAt })
    const after = yield* tasks.generation()
    console.log(JSON.stringify({ taskID: task.id, runID: run.id, before, after }))
    return
  }

  console.error(`unknown mode: ${mode}`)
  process.exit(2)
})

Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
