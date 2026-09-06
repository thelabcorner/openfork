import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
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

/**
 * Reads one complete SSE record, returning the `id:` field verbatim (including
 * its absence) so tests can assert control frames carry no cursor.
 */
const readFrame = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    let buffer = eventBuffers.get(reader) ?? ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = record.split(/\r?\n/)
        const line = lines.find((entry) => entry.startsWith("data: "))
        if (!line) continue
        eventBuffers.set(reader, buffer)
        const cursor = lines.find((entry) => entry.startsWith("id: "))?.slice(4)
        return {
          ...Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice("data: ".length))),
          cursor,
          hasId: lines.some((entry) => entry.startsWith("id: ")),
        }
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

describe("event HttpApi stream lifetime and control frames", () => {
  // Regression: the handler previously created its subscriber queue, coalescer
  // and bus subscription directly in the handler's Effect.gen. If the request
  // scope closes when the response VALUE is returned rather than when the BODY
  // completes, that teardown unsubscribes immediately and every subsequent live
  // event is lost. Creating them inside Stream.unwrap binds their lifetime to
  // the body stream. This test does not close the scope early itself — it proves
  // the subscription is still live long after the response was handed back, by
  // publishing a real event and requiring it to arrive.
  it.instance(
    "keeps the subscription alive for live events after the response is returned",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        const connected = yield* readFrame(reader)
        expect(connected.type).toBe("server.connected")
        expect(connected.hasId).toBe(true)

        // Let the request scope settle before asserting. A handler whose
        // resources are tied to the request scope would already be unsubscribed.
        yield* Effect.sleep("200 millis")

        // A real domain event published well after the response value existed.
        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        const delivered = yield* readFrame(reader)
        expect(delivered.type).toBe("session.created")
        expect(delivered.hasId).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )

  // Two concurrent subscribers must both stay live. Proves the fix is not
  // accidentally satisfied by one shared/global subscription, and that each
  // stream owns resources that survive independently.
  it.instance(
    "keeps two concurrent subscriptions live after both responses are returned",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const first = yield* openEventStream(directory)
        const second = yield* openEventStream(directory)
        expect((yield* readFrame(first.reader)).type).toBe("server.connected")
        expect((yield* readFrame(second.reader)).type).toBe("server.connected")

        yield* Effect.sleep("200 millis")

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect((yield* readFrame(first.reader)).type).toBe("session.created")
        expect((yield* readFrame(second.reader)).type).toBe("session.created")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )

  // Control frames are not replayable domain state. `server.stream.gap` used to
  // be stamped with `replay.latest`, a sequence already assigned to a real
  // event, producing a duplicate non-monotonic Last-Event-ID.
  it.instance(
    "emits the gap control frame without an id",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const initial = yield* openEventStream(directory)
        const connected = yield* readFrame(initial.reader)
        expect(connected.cursor).toMatch(/^[^:]+:\d+$/)

        // A cursor from another process is treated as a gap.
        const foreign = yield* openEventStream(directory, "previous-process:0")
        expect((yield* readFrame(foreign.reader)).type).toBe("server.connected")
        const gap = yield* readFrame(foreign.reader)
        expect(gap.type).toBe("server.stream.gap")
        expect(gap.hasId).toBe(false)
        expect(gap.cursor).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )

  // The disposal frame used to reuse `events.replayLatest()` — the last sequence
  // already assigned to a real event — so the terminal SSE id duplicated a
  // domain event's id. It must now carry no id, while still ending the stream.
  it.instance(
    "emits the disposal frame without an id and then ends the stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)
        expect(response.status).toBe(200)
        expect((yield* readFrame(reader)).type).toBe("server.connected")

        yield* requestInDirectory("/session", directory, { method: "POST" })
        const created = yield* readFrame(reader)
        expect(created.type).toBe("session.created")

        // `/global/dispose` runs disposal synchronously in the handler.
        // `/instance/dispose` only MARKS the instance; the teardown runs in
        // `disposeMiddleware`, which the in-process test layer does not install
        // (only `webHandler` does, server.ts:424), so it would never emit here.
        const disposed = yield* requestInDirectory(GlobalPaths.dispose, directory, { method: "POST" })
        expect(disposed.status).toBe(200)

        const frame = yield* readFrame(reader)
        expect(frame.type).toBe("server.instance.disposed")
        expect(frame.hasId).toBe(false)
        // A control frame must never reuse a domain event's cursor.
        expect(frame.cursor).toBeUndefined()
        expect(frame.cursor).not.toBe(created.cursor)

        // Disposal is terminal: the stream completes rather than idling open.
        const ended = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("ended" as const) }),
        )
        expect(ended).toBe("ended")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )
})
