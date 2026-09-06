import { afterEach, describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * Large-window instance reconnect.
 *
 * The whole replay window is enqueued synchronously inside `Stream.unwrap`,
 * before the response body stream is ever pulled, and
 * `makeByteBoundedSubscriberQueue.offer` FAILS the queue on overflow rather
 * than dropping. So the subscriber queue capacity is coupled to the replay
 * frame ceiling: raising MAX_REPLAY_FRAMES without raising the capacity turns
 * a reconnect more than `capacity` frames behind into a hard disconnect
 * instead of a replay or a gap.
 *
 * That coupling became load-bearing when MAX_REPLAY_FRAMES went 128 -> 4096
 * while the queue stayed at a bare `capacity: 256`. This covers the case no
 * existing instance-route test did: a real reconnect hundreds of frames behind.
 * The global route has the equivalent test in httpapi-global-replay.test.ts;
 * the two handlers are shaped the same and both need it.
 */

// The instance route emits the bare legacy envelope: `{ id, type, properties }`.
const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const decoder = new TextDecoder()

/**
 * Collect the raw SSE body on a background fiber. The response is never read to
 * completion: an open SSE stream ends only when the scope closes, so the test
 * reads whatever has arrived and stops.
 */
const collect = (source: Stream.Stream<Uint8Array, any>) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    yield* source.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          chunks.push(value)
        }),
      ),
      Effect.forkScoped,
    )
    return {
      settle: (ms: number) => Effect.sleep(`${ms} millis`),
      /** Every complete `data:` record decoded so far. */
      frames: () =>
        Effect.sync(() => {
          const text = chunks.map((c) => decoder.decode(c, { stream: true })).join("")
          const records: Array<{ type: string; cursor?: string; properties?: any }> = []
          for (const record of text.split("\n\n")) {
            const lines = record.split(/\r?\n/)
            const line = lines.find((entry) => entry.startsWith("data: "))
            if (!line) continue
            const cursor = lines.find((entry) => entry.startsWith("id: "))?.slice(4)
            const decoded = Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice("data: ".length)))
            records.push({ ...decoded, cursor })
          }
          return records
        }),
    }
  })

const openEventStream = (directory: string, cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory, {
      headers: cursor === undefined ? {} : { "Last-Event-ID": cursor },
    })
    // Surface a non-200 immediately instead of failing as an empty stream.
    expect(response.status).toBe(200)
    return yield* collect(response.stream)
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi large replay window", () => {
  // Regression: with MAX_REPLAY_FRAMES at the ring capacity but the subscriber
  // queue left at 256, this overflowed and failed the stream — surfacing as a
  // truncated body instead of replay frames.
  it.instance(
    "reconnects more than 256 frames behind without failing the stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const total = 300

        const first = yield* openEventStream(directory)
        yield* first.settle(300)
        const initial = yield* first.frames()
        expect(initial[0]?.type).toBe("server.connected")
        const cursor = initial[0]?.cursor
        expect(cursor).toBeDefined()

        // Publish well past the old 256 capacity. Session creation produces a
        // real routed instance event with a distinct id each time, so the
        // coalescer cannot merge them into a handful of frames.
        for (let i = 0; i < total; i++) {
          const response = yield* requestInDirectory("/session", directory, { method: "POST" })
          expect(response.status).toBe(200)
        }

        const second = yield* openEventStream(directory, cursor)
        yield* second.settle(3000)
        const replayed = yield* second.frames()
        const seen = replayed.filter((frame) => frame.type === "session.created")

        // Load-bearing: the stream survived past the 256th enqueue and replayed
        // the whole window rather than failing the queue and truncating.
        expect(seen.length).toBeGreaterThan(256)
      }).pipe(Effect.timeout("120 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 300_000 },
  )
})
