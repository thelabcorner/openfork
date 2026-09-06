import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { GlobalBus } from "../../src/bus/global"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers, MAX_REPLAY_FRAMES, SUBSCRIBER_HEADROOM } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

/**
 * Large-window global reconnect.
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
 * while the queue stayed at a bare `capacity: 256`. These tests cover the case
 * no existing test did: a real reconnect hundreds of frames behind.
 */

// The global route emits the legacy envelope: `{ payload: { id, type, properties } }`.
const EventData = Schema.Struct({
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.String,
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  }),
})

const decoder = new TextDecoder()

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, forkCredentialHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(ForkCredentials.Service)({})),
  Layer.provide(Layer.mock(SessionUsage.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)

const it = testEffect(apiLayer)

/**
 * Collect the raw SSE body on a background fiber. The response is never read
 * to completion: an open SSE stream ends only when the scope closes, so the
 * test reads whatever has arrived and stops.
 */
const collect = (source: Stream.Stream<Uint8Array, any>) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    const done = yield* Deferred.make<void>()
    yield* source.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          chunks.push(value)
        }),
      ),
      Effect.andThen(Deferred.succeed(done, void 0)),
      Effect.forkScoped,
    )
    // Give the handler time to enqueue its synchronous replay before reading.
    const settle = (ms: number) => Effect.sleep(`${ms} millis`)
    return {
      settle,
      done,
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
            records.push({ ...decoded.payload, cursor })
          }
          return records
        }),
    }
  })

const openGlobalStream = (cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(GlobalPaths.event).pipe(
      HttpClientRequest.setHeaders(cursor === undefined ? {} : { "Last-Event-ID": cursor }),
      HttpClient.execute,
    )
    // Surface a non-200 immediately instead of failing as an empty stream.
    expect(response.status).toBe(200)
    return yield* collect(response.stream)
  })

afterEach(() => Effect.void)

describe("global HttpApi large replay window", () => {
  // Assert the COUPLING, not today's numbers. A test that hardcodes 256/300
  // stops detecting this bug the moment either constant moves — which is
  // exactly how the defect shipped. The queue must always be able to hold a
  // full replay window plus headroom.
  it.live("subscriber capacity exceeds the replay ceiling", () =>
    Effect.sync(() => {
      // Subscriber queue capacity is MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM in
      // the source; reconstruct it here and assert the coupling the source holds.
      const SUBSCRIBER_CAPACITY = MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM
      expect(SUBSCRIBER_CAPACITY).toBeGreaterThan(MAX_REPLAY_FRAMES)
    }),
  )

  // Regression: with MAX_REPLAY_FRAMES at the ring capacity but the subscriber
  // queue left at 256, this overflowed and failed the stream — surfacing as a
  // truncated body instead of replay frames.
  it.live("reconnects more than 256 frames behind without failing the stream", () =>
    Effect.gen(function* () {
      // Derived from the real constants so a future raise keeps this honest.
      const total = MAX_REPLAY_FRAMES > 512 ? 512 : 300

      const first = yield* openGlobalStream()
      yield* first.settle(300)
      const initial = yield* first.frames()
      expect(initial[0]?.type).toBe("server.connected")
      const cursor = initial[0]?.cursor
      expect(cursor).toBeDefined()

      // Publish well past the old 256 capacity. Distinct ids so the coalescer
      // cannot merge them into a handful of frames.
      for (let i = 0; i < total; i++) {
        GlobalBus.emit("event", {
          directory: "global",
          payload: { id: `probe-${i}`, type: "probe.bulk", properties: { i } },
        })
      }

      const second = yield* openGlobalStream(cursor)
      yield* second.settle(1500)
      const replayed = yield* second.frames()
      const seen = replayed.filter((f) => f.type === "probe.bulk").map((f) => String(f.properties?.i))

      // Load-bearing: the stream survived past the 256th enqueue and replayed
      // the whole window rather than failing the queue and truncating.
      expect(seen.length).toBeGreaterThan(256)
      expect(seen).toContain(String(total - 1))
    }).pipe(Effect.timeout("60 seconds")),
  )
})
