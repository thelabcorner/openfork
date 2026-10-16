import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Queue, Stream } from "effect"
import { parseEventSequence } from "@opencode-ai/core/event-replay"
import { EventManifest } from "../../src/event-manifest"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

/**
 * Producer-side contract for the retained OpenCode 1.x `/event` SSE transport
 * that stock T3 Code subscribes to through `@opencode-ai/sdk` 1.15.13.
 *
* Scope note: `httpapi-event-lifetime.test.ts` already pins the LIVE path — that
 * `server.connected` is the first frame, that the gap and disposal frames carry
 * no `id:`, and that disposal terminates the stream. This file deliberately does
 * not repeat those. It pins the layer that live-path assertions structurally
 * cannot reach: whether a control-frame TYPE can ever be re-stamped with a cursor
 * by the replay ring on reconnect.
 *
 * It also owns the one keepalive fact no other suite asserts: that
 * `server.heartbeat` reaches the client as a real SSE DATA frame. That is not a
 * cosmetic distinction. The generated SDK parser reads a `: comment` line as an
 * unknown field, producing a frame with no data that it never yields to the
 * caller, so a comment-based keepalive would leave a quiet T3 session looking dead
 * while every existing event test still passed — those tests skip any record
 * without a `data:` line, so they are blind to exactly this regression.
 */

/**
 * The four frames the legacy transport synthesizes rather than projects from
 * domain state. They are not replayable domain state, so none of them may ever
 * acquire a sequence.
 */
const controlFrames = [
  "server.connected",
  "server.heartbeat",
  "server.stream.gap",
  "server.instance.disposed",
] as const

describe("T3 Code legacy /event control-frame cursor contract", () => {
  // This is the invariant that protects the live-path regressions. `handlers/event.ts`
  // stamps a cursor from the event's sequence, and `handlers/event.ts` reaches the
  // replay ring through `replaySince(...)`. If a control-frame type were ever
  // admitted to the durable manifest, a reconnect would replay it from the ring
  // WITH a sequence and re-introduce exactly the duplicate, non-monotonic
  // Last-Event-ID that `httpapi-event-lifetime.test.ts:131` and `:155` were
  // written to prevent — while every live-path assertion still passed, because
  // the defect only exists on the reconnect path.
  test("no control frame is admitted to the replayable ring", () => {
    for (const frame of controlFrames) {
      expect(EventManifest.Durable.has(frame), `${frame} must never become replayable`).toBe(false)
    }
  })

  // Without a positive control this whole file could pass against an empty or
  // collapsed Durable manifest. Durable is a strict subset of Latest by
  // construction, so assert both directions: `server.connected` is a real
  // schema-backed event that merely is not replayable, while the other three
  // are transport-level frames with no manifest entry at all. Both facts matter
  // and they are deliberately different.
  test("control frames split into schema-backed and transport-only", () => {
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    for (const frame of ["server.heartbeat", "server.stream.gap", "server.instance.disposed"] as const) {
      expect(EventManifest.Latest.has(frame), `${frame} is transport-level, not manifest-backed`).toBe(false)
    }

    // Positive control: durable domain state does exist, so the assertions above
    // distinguish "not replayable" from "replay ring is empty".
    expect(EventManifest.Durable.size).toBeGreaterThan(0)
    expect(EventManifest.Latest.size).toBeGreaterThan(EventManifest.Durable.size)
  })

  // Domain state T3 consumes IS replayable, which is the contrast that makes a
  // control frame's missing cursor meaningful rather than incidental.
  test("T3-consumed domain events remain replayable", () => {
    for (const event of ["session.updated", "message.updated", "message.part.updated"]) {
      expect(EventManifest.Latest.has(event), `${event} must remain available to T3`).toBe(true)
    }
  })
})

describe("T3 Code legacy /event cursor parsing", () => {
  const epoch = "ep_current"

  // The legacy SDK's EventSource cannot set headers, so it reconnects with
  // `Last-Event-ID`. This is the exact value the transport puts on the wire.
  test("round-trips an epoch-scoped cursor", () => {
    expect(parseEventSequence(`${epoch}:42`, epoch)).toBe(42)
    expect(parseEventSequence(`${epoch}:0`, epoch)).toBe(0)
  })

  test("treats an absent cursor as a fresh subscription", () => {
    expect(parseEventSequence(undefined, epoch)).toBeUndefined()
    expect(parseEventSequence("", epoch)).toBeUndefined()
    expect(parseEventSequence("   ", epoch)).toBeUndefined()
  })

  // The load-bearing fail-closed case. A cursor minted by a PREVIOUS process
  // carries a different epoch and must never be read as "no cursor", because
  // that would silently downgrade a reconnect into a fresh subscription and
  // skip every event in between. It returns -1 so the caller emits
  // `server.stream.gap` instead.
  test("rejects a cursor from a stale epoch rather than ignoring it", () => {
    expect(parseEventSequence("ep_previous:0", epoch)).toBe(-1)
    expect(parseEventSequence(`${epoch}x:1`, epoch)).toBe(-1)
  })

  // Documents a deliberate asymmetry, so a future simplification does not
  // quietly remove the fail-closed epoch guard. With no epoch to compare against
  // there is nothing to mismatch, so a malformed value degrades to "fresh".
  test("degrades to a fresh subscription only when no epoch is supplied", () => {
    expect(parseEventSequence("not-a-number", epoch)).toBe(-1)
    expect(parseEventSequence("not-a-number")).toBeUndefined()
    expect(parseEventSequence("-1")).toBeUndefined()
  })
})
const LEGACY_HANDLER = "../../src/server/routes/instance/httpapi/handlers/event.ts"
const LEGACY_EVENT_GROUP = "../../src/server/routes/instance/httpapi/groups/event.ts"

/**
 * Reads one raw SSE record, keeping records that carry NO `data:` line.
 *
 * The distinction matters: every other frame reader in this package discards a
 * record with no data (it `continue`s to the next boundary), which is exactly
 * what an SSE comment looks like. Surfacing those records is what makes the
 * "never a comment" assertion below non-vacuous — if the keepalive regressed to
 * `: heartbeat`, this reader would still see the record and the assertion would
 * fail instead of silently skipping it.
 */
type RawRecord = { lines: string[]; data: string | undefined; cursor: string | undefined }

const recordBuffers = new WeakMap<object, string>()
const recordDecoder = new TextDecoder()

const readRawRecord = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    let buffer = recordBuffers.get(reader) ?? ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        recordBuffers.set(reader, buffer)
        const lines = record.split(/\r?\n/)
        return {
          lines,
          data: lines.find((line) => line.startsWith("data: "))?.slice("data: ".length),
          cursor: lines.find((line) => line.startsWith("id: "))?.slice("id: ".length),
        } satisfies RawRecord
      }

      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for an SSE record on /event")),
        }),
      )
      buffer += recordDecoder.decode(value, { stream: true })
    }
  })

const isCommentRecord = (record: RawRecord) => record.lines.some((line) => line.startsWith(":"))

const openLegacyStream = (directory: string, lastEventID?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory, {
      headers: lastEventID ? { "last-event-id": lastEventID } : undefined,
    })
    const reader = yield* Queue.unbounded<Uint8Array>()
    const fiber = yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader, fiber }
  })

const openLegacyStreamWithEncodedDirectory = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* request(EventPaths.event, {
      headers: { "x-opencode-directory": encodeURIComponent(directory) },
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

describe("T3 Code legacy /event heartbeat transport", () => {
  // One 10s window yields three coupled facts about the same frames, so they are
  // asserted together rather than paying the heartbeat tick three times. The
  // producer ticks at 10s with the first tick dropped (handlers/event.ts:252-255),
  // so an idle stream emits `server.connected` immediately and the first
  // heartbeat ~10s later — no domain traffic needed to reach it.
  it.instance(
    "delivers server.heartbeat as a data frame, with no cursor and no comment frames",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openLegacyStream(directory)
        expect(response.status).toBe(200)

        const seen: RawRecord[] = []
        let heartbeat: RawRecord | undefined
        while (heartbeat === undefined) {
          const record = yield* readRawRecord(reader)
          seen.push(record)
          if (record.data !== undefined) {
            const frame = JSON.parse(record.data) as { id?: string; type?: string; properties?: unknown }
            if (frame.type === "server.heartbeat") heartbeat = record
          }
        }

        // A real DATA frame, so the generated SDK actually yields it. A comment
        // would have been dropped by every other reader in this package.
        expect(heartbeat.data).toBeDefined()
        const frame = JSON.parse(heartbeat.data!) as { id?: string; type?: string; properties?: unknown }
        expect(frame.type).toBe("server.heartbeat")
        expect(frame.properties).toEqual({})
        expect(typeof frame.id).toBe("string")

        // Keepalive must not advance Last-Event-ID. A heartbeat that minted a
        // cursor would move the reconnect point past domain events the client
        // never observed, because it is merged with haltStrategy "left" and can
        // overtake queued replay/live frames.
        expect(heartbeat.cursor).toBeUndefined()
        expect(heartbeat.lines.some((line) => line.startsWith("id: "))).toBe(false)

        // No record in the window was an SSE comment, i.e. the keepalive is a
        // data frame rather than a `: heartbeat` line the SDK parser discards.
        expect(seen.filter(isCommentRecord)).toEqual([])
        // Guards against a degenerate single-record read making the above vacuous.
        expect(seen.length).toBeGreaterThanOrEqual(2)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )
})

describe("T3 Code legacy /event domain delivery", () => {
  // T3 does not only need the keepalive: it needs the domain event vocabulary to
  // reach a subscriber that is ALREADY connected. That path is structurally
  // different from the keepalive path — synthesized frames
  // (`server.connected`/`server.heartbeat`/`server.stream.gap`) are injected
  // directly into the body and never pass through `matches` or `sequenceOf`,
  // whereas a domain event must survive both filters in handlers/event.ts:
  // `matches` requires `event.location?.directory === directory` (:147) and the
  // callback drops any event whose `sequenceOf` is `undefined` (:164).
  //
  // So a suite that only asserts synthesized frames can be fully green while
  // domain delivery is dead. This measures the thing directly and deliberately
  // separates the two failure shapes the neighboring lifetime suite cannot:
  // "never arrives" (a filter drops it, so no timeout budget helps) from
  // "arrives late" (delivered, but past a fixed 5s wait). `delivered:false` with
  // only heartbeats in `framesSeen` means never; a large `elapsedMs` means late.
  it.instance(
    "delivers session.created to a subscriber that connected before it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openLegacyStream(directory)

        const first = yield* readRawRecord(reader)
        expect(JSON.parse(first.data!).type).toBe("server.connected")

        const start = Date.now()
        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)

        // Read with this file's generous 30s per-record budget rather than the
        // 5s cap, so a slow-but-correct delivery is distinguishable from none.
        // Heartbeats arrive every ~10s, so this loop always makes progress.
        const framesSeen: string[] = []
        let elapsedMs = -1
        let createdInfo: { directory?: string; id?: string } | undefined
        while (Date.now() - start < 45_000) {
          const record = yield* readRawRecord(reader)
          if (record.data === undefined) continue
          const frame = JSON.parse(record.data) as {
            type?: string
            properties?: { info?: { directory?: string; id?: string } }
          }
          framesSeen.push(frame.type ?? "<untyped>")
          if (frame.type === "session.created") {
            elapsedMs = Date.now() - start
            createdInfo = frame.properties?.info
            break
          }
        }

        // Reported as one object so a failure prints the evidence that
        // distinguishes the two shapes, rather than a bare expected/actual.
        expect({ delivered: elapsedMs >= 0, elapsedMs, framesSeen }).toMatchObject({ delivered: true })

        // Arrival ALONE does not pin this defect: a locationless `session.created`
        // would still reach any consumer that does not filter by location, so a
        // frame-count assertion would go green against the defective publish and
        // mask it. Pin the location field itself — the thing whose absence made
        // every location-routed consumer drop the event. Compared normalized so a
        // Windows path-form difference cannot masquerade as a location defect.
        const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        expect(
          normalize(createdInfo?.directory ?? ""),
          "session.created must carry the populated location its consumers route on",
        ).toBe(normalize(directory))
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )

  it.instance(
    "replays session.created on reconnect using the prior SSE cursor",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const first = yield* openLegacyStream(directory)
        const connected = yield* readRawRecord(first.reader)
        expect(JSON.parse(connected.data!).type).toBe("server.connected")
        expect(connected.cursor).toBeDefined()

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        const session = (yield* created.json) as { id: string }
        expect(session.id).toBeDefined()
        // Leave the event unread on the first body. Reconnecting with the last
        // cursor actually observed must replay it from the ring.
        yield* Fiber.interrupt(first.fiber)

        const resumed = yield* openLegacyStream(directory, connected.cursor)
        const framesSeen: string[] = []
        let replayed = false
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && !replayed) {
          const record = yield* readRawRecord(resumed.reader)
          if (record.data === undefined) continue
          const frame = JSON.parse(record.data) as {
            type?: string
            properties?: { info?: { id?: string } }
          }
          framesSeen.push(frame.type ?? "<untyped>")
          if (frame.type === "session.created" && frame.properties?.info?.id === session.id) replayed = true
        }
        yield* Fiber.interrupt(resumed.fiber)
        expect({ replayed, framesSeen }).toMatchObject({ replayed: true })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 30_000 },
  )

  it.instance(
    "preserves a literal percent escape in the SDK-encoded directory carrier",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const scoped = path.join(directory, "pct%20event")
        yield* Effect.promise(() => mkdir(scoped, { recursive: true }))

        // Stock SDK 1.x URI-encodes x-opencode-directory, so the literal "%20"
        // reaches the wire as "%2520". WorkspaceRoutingMiddleware owns the sole
        // decode and must leave the routed path as literal "%20".
        const { response, reader } = yield* openLegacyStreamWithEncodedDirectory(scoped)
        expect(response.status).toBe(200)
        const first = yield* readRawRecord(reader)
        expect(JSON.parse(first.data!).type).toBe("server.connected")

        const created = yield* request("/session", {
          method: "POST",
          headers: { "x-opencode-directory": encodeURIComponent(scoped) },
        })
        expect(created.status).toBe(200)

        const framesSeen: string[] = []
        let createdDirectory: string | undefined
        const deadline = Date.now() + 25_000
        while (Date.now() < deadline) {
          const record = yield* readRawRecord(reader)
          if (record.data === undefined) continue
          const frame = JSON.parse(record.data) as {
            type?: string
            properties?: { info?: { directory?: string } }
          }
          framesSeen.push(frame.type ?? "<untyped>")
          if (frame.type === "session.created") {
            createdDirectory = frame.properties?.info?.directory
            break
          }
        }

        expect(
          { delivered: createdDirectory !== undefined, createdDirectory, framesSeen },
          "a second decode turns literal %20 into a space and makes the domain event invisible",
        ).toMatchObject({ delivered: true })
        expect(path.resolve(createdDirectory ?? "")).toBe(path.resolve(scoped))
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 120_000 },
  )
})

describe("T3 Code legacy /event producer shape", () => {
  // The live test above can only observe the keepalive once per 10s tick, so
  // these structural pins guard the encoder-level path that produced it: the
  // frame must be built by `eventData` (which always sets `data`), and the
  // transport must never reach for an SSE comment at all.
  test("synthesizes the heartbeat through eventData and never as an SSE comment", async () => {
    const source = await Bun.file(new URL(LEGACY_HANDLER, import.meta.url)).text()

    expect(source).toContain('type: "server.heartbeat"')
    // Exactly the call shape in handlers/event.ts:254 — no second argument, so
    // `eventData` omits `id:` (handlers/event.ts:81) and the frame stays
    // sequence-free.
    expect(source).toMatch(/eventData\(\{ id: eventID\(\), type: "server\.heartbeat", properties: \{\} \}\)/)
    expect(source).not.toMatch(/eventData\(\{ id: eventID\(\), type: "server\.heartbeat", properties: \{\} \},/)
    // A comment carries no data and is never yielded by the SDK client, so it
    // cannot refresh stream liveness. The transport must not emit one.
    expect(source).not.toContain("Sse.comment(")
    expect(source).not.toContain("Sse.comment ")

    // Positive control for the two negatives above. Without it they are
    // vacuous: deleting the `Sse` import and re-encoding frames some other way
    // would satisfy both while the file no longer emits SSE at all, turning this
    // into a green test that names a mechanism it never checked. `Sse.Event` is
    // the encoder's own return type, so its presence proves the SSE namespace is
    // live in THIS file and the absences above are meaningful.
    expect(source, "SSE namespace must be live for the comment negatives to mean anything").toContain("Sse.Event")
  })

  // The 10s cadence is load-bearing against a client-side silence timeout: T3's
  // v2 path fails a stream after 45s of zero bytes, so a legacy keepalive that
  // stopped ticking, or that `drop(1)` was removed from (emitting an immediate
  // first frame that is not a real interval), would change observable behaviour.
  test("keeps the heartbeat on a 10 second tick with the first tick dropped", async () => {
    const source = await Bun.file(new URL(LEGACY_HANDLER, import.meta.url)).text()

    expect(source).toContain('Stream.tick("10 seconds")')
    expect(source).toMatch(/Stream\.tick\("10 seconds"\)\.pipe\(\s*Stream\.drop\(1\)/)
  })

  // `/event` is wrapped by the same `Authorization` middleware as every other
  // route, and that middleware reads `Authorization: Basic ...` with no
  // SSE-specific branch (middleware/authorization.ts:82-88). T3's SDK uses
  // fetch, so it can set the header; a browser EventSource could not and uses
  // `?auth_token=` instead. Both are accepted, and the query wins when both are
  // present.
  test("mounts the shared Authorization middleware on the event group", async () => {
    const source = await Bun.file(new URL(LEGACY_EVENT_GROUP, import.meta.url)).text()

    expect(source).toMatch(/\.middleware\(Authorization\)/)
    expect(source).toContain('contentType: "text/event-stream"')
  })
})
