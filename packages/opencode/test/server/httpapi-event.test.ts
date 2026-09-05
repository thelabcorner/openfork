import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const eventBuffers = new WeakMap<object, string>()
const eventDecoder = new TextDecoder()

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    let buffer = eventBuffers.get(reader) ?? ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const line = record.split(/\r?\n/).find((entry) => entry.startsWith("data: "))
        if (!line) continue
        eventBuffers.set(reader, buffer)
        const cursor = record.split(/\r?\n/).find((entry) => entry.startsWith("id: "))?.slice(4)
        return { ...Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice("data: ".length))), cursor }
      }

      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
      )
      buffer += eventDecoder.decode(value, { stream: true })
    }
  })

const openEventStream = (directory: string, cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory, {
      headers: cursor === undefined ? undefined : { "Last-Event-ID": cursor },
    })
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "rejects foreign epochs and does not acknowledge replay before delivery",
    () => Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const initial = yield* openEventStream(directory)
      const connected = yield* readEvent(initial.reader)
      expect(connected.cursor).toMatch(/^[^:]+:\d+$/)
      expect(connected.properties.epoch).toBe(connected.cursor!.split(":")[0])
      yield* requestInDirectory("/session", directory, { method: "POST" })
      const created = yield* readEvent(initial.reader)
      expect(created.type).toBe("session.created")
      const resumed = yield* openEventStream(directory, connected.cursor)
      expect((yield* readEvent(resumed.reader)).cursor).toBeUndefined()
      const replayed = yield* readEvent(resumed.reader)
      expect(replayed.id).toBe(created.id)
      expect(replayed.cursor).toBe(created.cursor)
      const foreign = yield* openEventStream(directory, "previous-process:0")
      expect((yield* readEvent(foreign.reader)).cursor).toBeUndefined()
      expect((yield* readEvent(foreign.reader)).type).toBe("server.stream.gap")
    }),
    { git: true, config: { formatter: false, lsp: false } },
  )
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
