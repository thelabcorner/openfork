/**
 * Concurrent-session runner-history benchmark.
 *
 * Measures the production history decoder against the active-run projection
 * used by SessionRunner after the contention remediation. This is a throwaway
 * harness, not a *.test.ts file.
 *
 * Run: bun run packages/core/test/bench-runner-history.ts
 */
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database as CoreDatabase } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventSequenceTable } from "../src/event/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionHistory } from "../src/session/history"
import { SessionMessage } from "../src/session/message"
import { makeRunnerHistoryProjection } from "../src/session/runner/history-projection"
import { SessionSchema } from "../src/session/schema"
import { SessionMessageTable, SessionTable } from "../src/session/sql"

const dbLayer = CoreDatabase.layerFromPath(":memory:")
const eventLayer = EventV2.layerWith().pipe(Layer.provide(dbLayer))
const layer = Layer.merge(dbLayer, eventLayer)
const encode = Schema.encodeSync(SessionMessage.Message)

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const makeRows = (sessionID: SessionSchema.ID, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const message = SessionMessage.User.make({
      id: SessionMessage.ID.make(`msg_${sessionID}_${index}`),
      type: "user",
      text: `history ${index}`,
      time: { created: DateTime.makeUnsafe(index + 1) },
    })
    const { id, type, ...data } = encode(message)
    return {
      id: SessionMessage.ID.make(id),
      session_id: sessionID,
      type,
      seq: index,
      time_created: index + 1,
      data,
      search_text: message.text,
    }
  })

const program = Effect.gen(function* () {
  const { db, readDb } = yield* CoreDatabase.Service
  const events = yield* EventV2.Service
  const directory = AbsolutePath.make("/bench")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  console.log("\n=== Concurrent-session runner-history bench ===")
  console.log(
    `${"rows".padStart(7)} | ${"cold snapshot ms".padStart(16)} | ${"full reload ms".padStart(14)} | ${"warm view us".padStart(12)} | ${"cold max lag ms".padStart(15)}`,
  )
  console.log("--------+------------------+----------------+--------------+-----------------")

  for (const count of [100, 1_000, 5_000]) {
    const sessionID = SessionSchema.ID.make(`ses_bench_history_${count}`)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory,
        title: "bench",
        version: "bench",
      })
      .run()
      .pipe(Effect.orDie)
    const rows = makeRows(sessionID, count)
    for (let offset = 0; offset < rows.length; offset += 200) {
      yield* db
        .insert(SessionMessageTable)
        .values(rows.slice(offset, offset + 200))
        .run()
        .pipe(Effect.orDie)
    }
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: count - 1 }).run().pipe(Effect.orDie)

    const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })
    let lastTick = performance.now()
    let maxLag = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - lastTick)
      lastTick = now
    }, 1)
    const coldStart = performance.now()
    const first = yield* history.entries(-1)
    const coldMs = performance.now() - coldStart
    yield* Effect.sleep("5 millis")
    clearInterval(timer)
    if (first.length !== count) throw new Error(`cold projection mismatch: ${first.length} != ${count}`)

    const reloads: number[] = []
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now()
      const loaded = yield* SessionHistory.entriesForRunner(readDb, sessionID, -1)
      reloads.push(performance.now() - start)
      if (loaded.length !== count) throw new Error(`reload mismatch: ${loaded.length} != ${count}`)
    }

    const warmIters = 10_000
    const warmStart = performance.now()
    for (let iteration = 0; iteration < warmIters; iteration++) yield* history.entries(-1)
    const warmUs = ((performance.now() - warmStart) / warmIters) * 1_000

    console.log(
      `${String(count).padStart(7)} | ${coldMs.toFixed(2).padStart(16)} | ${median(reloads).toFixed(2).padStart(14)} | ${warmUs.toFixed(3).padStart(12)} | ${maxLag.toFixed(2).padStart(15)}`,
    )
    yield* history.close
  }
}).pipe(Effect.scoped, Effect.provide(layer))

Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
