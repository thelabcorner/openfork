import { expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTrace } from "@opencode-ai/core/event-trace"

const Probe = EventV2.define({
  type: "test.sqlite-writer-admission",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, value: Schema.String },
})

test("post-BEGIN SQLITE_BUSY cannot replay admission callbacks or commit a later retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-durable-post-begin-"))
  const filename = join(directory, "event.sqlite")
  try {
    const layer = EventV2.layerWith().pipe(Layer.provideMerge(Database.layerFromPath(filename)))
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        let admissions = 0
        const outcome = yield* Effect.exit(events.publish(
          Probe,
          { id: "must-not-replay", value: "payload" },
          {
            admit: () => Effect.sync(() => {
              admissions++
              if (admissions === 1)
                throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
            }),
          },
        ))
        expect(outcome._tag).toBe("Failure")
        expect(admissions).toBe(1)
        const persisted = yield* db.get<{ n: number }>(sql`
          SELECT COUNT(*) AS n FROM event WHERE aggregate_id = 'must-not-replay'
        `).pipe(Effect.orDie)
        expect(persisted?.n).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 20_000)

test("durable event traces BEGIN admission separately from transaction body under WAL contention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-durable-begin-"))
  const filename = join(directory, "event.sqlite")
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let holder: NativeDatabase | undefined
  let holding = false
  EventTrace.configure({ enabled: true })
  EventTrace.reset()
  try {
    const layer = EventV2.layerWith().pipe(Layer.provideMerge(Database.layerFromPath(filename)))
    await Effect.runPromise(Effect.gen(function* () {
      const events = yield* EventV2.Service
      holder = new NativeDatabase(filename)
      holder.run("PRAGMA busy_timeout=0")
      holder.run("BEGIN IMMEDIATE")
      holding = true
      releaseTimer = setTimeout(() => {
        holder!.run("COMMIT")
        holding = false
      }, 220)
      yield* events.publish(Probe, { id: "trace-admission", value: "one" })
    }).pipe(Effect.scoped, Effect.provide(layer)))

    const trace = EventTrace.state()
    const wait = trace.timings["durable.begin.wait"]
    const body = trace.timings["durable.transaction"]
    const total = trace.timings["durable.writer.total"]
    expect(wait?.count).toBe(1)
    expect(wait!.maxMs).toBeGreaterThanOrEqual(75)
    expect(body?.count).toBe(1)
    expect(total?.count).toBe(1)
    expect(total!.maxMs).toBeGreaterThanOrEqual(wait!.maxMs)
    expect(trace.timings[`durable.begin.wait.${Probe.type}`]?.count).toBe(1)
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer)
    if (holding) holder?.run("ROLLBACK")
    holder?.close()
    EventTrace.configure({ enabled: false })
    EventTrace.reset()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
