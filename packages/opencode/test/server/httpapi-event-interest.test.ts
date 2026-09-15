import { afterEach, describe, expect } from "bun:test"
import { EventTrace } from "@opencode-ai/core/event-trace"
import {
  STREAM_INTEREST_SESSIONS_HEADER,
  STREAM_INTEREST_SUBSCRIBER_HEADER,
  STREAM_PROGRESS_EVENT,
  STREAM_SESSION_STALE_EVENT,
} from "@opencode-ai/core/session-stream-content"
import { Duration, Effect, Fiber, Queue, Stream } from "effect"
import os from "node:os"
import path from "node:path"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

type Frame = {
  readonly id?: string
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly cursor?: string
}

type LegacyFrame = {
  readonly directory?: string
  readonly payload: {
    readonly id?: string
    readonly type: string
    readonly properties?: Record<string, unknown>
  }
  readonly cursor?: string
}

const buffers = new WeakMap<object, string>()
const decoder = new TextDecoder()

const readFrame = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    let buffer = buffers.get(reader) ?? ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = record.split(/\r?\n/)
        const data = lines.find((line) => line.startsWith("data: "))
        if (!data) continue
        buffers.set(reader, buffer)
        return {
          ...(JSON.parse(data.slice("data: ".length)) as Omit<Frame, "cursor">),
          cursor: lines.find((line) => line.startsWith("id: "))?.slice(4),
        } satisfies Frame
      }

      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("event timeout")) }),
      )
      buffer += decoder.decode(value, { stream: true })
    }
  })

const readLegacyFrame = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    let buffer = buffers.get(reader) ?? ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = record.split(/\r?\n/)
        const data = lines.find((line) => line.startsWith("data: "))
        if (!data) continue
        buffers.set(reader, buffer)
        return {
          ...(JSON.parse(data.slice("data: ".length)) as Omit<LegacyFrame, "cursor">),
          cursor: lines.find((line) => line.startsWith("id: "))?.slice(4),
        } satisfies LegacyFrame
      }

      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("legacy event timeout")) }),
      )
      buffer += decoder.decode(value, { stream: true })
    }
  })

const readMeaningfulFrame = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    while (true) {
      const frame = yield* readFrame(reader)
      if (frame.type !== "server.heartbeat") return frame
    }
  })

const readUntil = (reader: Queue.Dequeue<Uint8Array>, accept: (frame: Frame) => boolean) =>
  Effect.gen(function* () {
    while (true) {
      const frame = yield* readFrame(reader)
      if (accept(frame)) return frame
    }
  })

const expectNoMatchingFrame = (
  reader: Queue.Dequeue<Uint8Array>,
  accept: (frame: Frame) => boolean,
  duration: Duration.Input = "150 millis",
) =>
  readUntil(reader, accept).pipe(
    Effect.as(false),
    Effect.timeoutOrElse({ duration, orElse: () => Effect.succeed(true) }),
  )

const latestProgressUntilQuiet = (reader: Queue.Dequeue<Uint8Array>, quiet: Duration.Input = "250 millis") =>
  Effect.gen(function* () {
    let latest: Frame | undefined
    while (true) {
      const next = yield* readUntil(reader, (frame) => frame.type === STREAM_PROGRESS_EVENT).pipe(
        Effect.map((frame): Frame | undefined => frame),
        Effect.timeoutOrElse({ duration: quiet, orElse: () => Effect.succeed(undefined) }),
      )
      if (!next) return latest
      latest = next
    }
  })

const drainUntilQuiet = (reader: Queue.Dequeue<Uint8Array>, duration: Duration.Input = "100 millis") =>
  Effect.gen(function* () {
    while (true) {
      const received = yield* readFrame(reader).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration, orElse: () => Effect.succeed(false) }),
      )
      if (!received) return
    }
  })

const frameSessionID = (frame: Frame) => {
  if (typeof frame.data?.sessionID === "string") return frame.data.sessionID
  const part = frame.data?.part
  if (part && typeof part === "object" && typeof (part as { sessionID?: unknown }).sessionID === "string")
    return (part as { sessionID: string }).sessionID
}

const legacyFrameSessionID = (frame: LegacyFrame) => {
  const properties = frame.payload.properties
  if (typeof properties?.sessionID === "string") return properties.sessionID
  const part = properties?.part
  if (part && typeof part === "object" && typeof (part as { sessionID?: unknown }).sessionID === "string")
    return (part as { sessionID: string }).sessionID
}

const streamHeaders = (subscriber: string, sessions: readonly string[], cursor?: string) => ({
  [STREAM_INTEREST_SUBSCRIBER_HEADER]: subscriber,
  [STREAM_INTEREST_SESSIONS_HEADER]: JSON.stringify(sessions),
  ...(cursor ? { "Last-Event-ID": cursor } : {}),
})

const openEventStream = (directory: string, subscriber: string, sessions: readonly string[], cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory("/api/event", directory, {
      headers: streamHeaders(subscriber, sessions, cursor),
    })
    expect(response.status).toBe(200)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return reader
  })

const openLegacyEventStream = (directory: string, subscriber: string, sessions: readonly string[], cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(GlobalPaths.event, directory, {
      headers: streamHeaders(subscriber, sessions, cursor),
    })
    expect(response.status).toBe(200)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return reader
  })

const openLegacyPassThroughStream = (directory: string, cursor?: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(GlobalPaths.event, directory, {
      headers: cursor ? { "Last-Event-ID": cursor } : undefined,
    })
    expect(response.status).toBe(200)
    const reader = yield* Queue.unbounded<Uint8Array>()
    const fiber = yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { reader, fiber }
  })

const readLegacyUntil = (reader: Queue.Dequeue<Uint8Array>, accept: (frame: LegacyFrame) => boolean) =>
  Effect.gen(function* () {
    while (true) {
      const frame = yield* readLegacyFrame(reader)
      if (accept(frame)) return frame
    }
  })

const drainLegacyUntilQuiet = (reader: Queue.Dequeue<Uint8Array>, duration: Duration.Input = "100 millis") =>
  Effect.gen(function* () {
    while (true) {
      const received = yield* readLegacyFrame(reader).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration, orElse: () => Effect.succeed(false) }),
      )
      if (!received) return
    }
  })

const collectLegacyUntilQuiet = (reader: Queue.Dequeue<Uint8Array>, duration: Duration.Input = "250 millis") =>
  Effect.gen(function* () {
    const frames: LegacyFrame[] = []
    while (true) {
      const next = yield* readLegacyFrame(reader).pipe(
        Effect.map((frame): LegacyFrame | undefined => frame),
        Effect.timeoutOrElse({ duration, orElse: () => Effect.succeed(undefined) }),
      )
      if (!next) return frames
      frames.push(next)
    }
  })

const createSession = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory("/api/session", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory } }),
    })
    expect(response.status).toBe(200)
    return ((yield* response.json) as { data: { id: string } }).data
  })

const publishPrompt = (
  directory: string,
  sessionID: string,
  index: number,
  payload = "x".repeat(512),
) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(`/api/session/${sessionID}/prompt`, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: { text: `${index}:${payload}` },
        resume: false,
      }),
    })
    if (response.status !== 200) {
      const body = yield* response.text
      return yield* Effect.fail(new Error(`current prompt failed (${response.status}): ${body}`))
    }
  })

const createLegacySession = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory("/session", directory, { method: "POST" })
    expect(response.status).toBe(200)
    return (yield* response.json) as { id: string }
  })

type LegacyTextPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "text"
  readonly text: string
}

const seedLegacyTextPart = (directory: string, sessionID: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(`/session/${sessionID}/message`, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "seed" }],
      }),
    })
    expect(response.status).toBe(200)
    const message = (yield* response.json) as { parts: LegacyTextPart[] }
    const part = message.parts.find((item) => item.type === "text")
    if (!part) return yield* Effect.fail(new Error("legacy seed prompt returned no text part"))
    return part
  })

const updateLegacyTextPart = (directory: string, part: LegacyTextPart, text: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(
      `/session/${part.sessionID}/message/${part.messageID}/part/${part.id}`,
      directory,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...part, text }),
      },
    )
    if (response.status !== 200) {
      const body = yield* response.text
      return yield* Effect.fail(new Error(`legacy part update failed (${response.status}): ${body}`))
    }
  })

// EventV2 is a memoized global service. The shared runner is load-bearing here:
// current-session HTTP mutations and the native /api/event handler must resolve
// the same in-process bus exactly as they do in production.
const it = testEffectShared(httpApiLayer)

afterEach(async () => {
  EventTrace.configure({ enabled: false })
  await disposeAllInstances()
  await resetDatabase()
})

describe("native SSE session interest", () => {
  it.instance(
    "suppresses high-volume background content upstream and mutates interest without reconnecting",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const foreground = (yield* createSession(directory)).id
        const background = (yield* createSession(directory)).id
        const subscriber = "sub_httpapi_interest"

        EventTrace.configure({ enabled: true, directory: path.join(os.tmpdir(), "opencode-event-interest-trace") })

        const reader = yield* openEventStream(directory, subscriber, [foreground])
        expect((yield* readFrame(reader)).type).toBe("server.connected")
        // /api/event is server-wide, so plugin/catalog initialization may emit
        // unrelated frames as the instance warms. Remove that setup traffic from
        // the measured window rather than pretending this is a session-only bus.
        yield* drainUntilQuiet(reader)
        EventTrace.reset()

        // An admitted foreground prompt establishes that ordinary domain traffic
        // still traverses the exact same native stream.
        yield* publishPrompt(directory, foreground, 0, "foreground")

        // This models the real clog: another agent/session streaming hundreds of
        // token fragments while the user is looking at a different timeline.
        const suppressed = 128
        for (let index = 0; index < suppressed; index++) yield* publishPrompt(directory, background, index)

        const admitted = yield* readUntil(
          reader,
          (frame) => frame.type === "session.next.prompt.admitted" && frameSessionID(frame) === foreground,
        )
        expect(admitted.type).toBe("session.next.prompt.admitted")
        expect(admitted.data?.sessionID).toBe(foreground)

        const stale = yield* readUntil(
          reader,
          (frame) => frame.type === STREAM_SESSION_STALE_EVENT && frameSessionID(frame) === background,
        )
        expect(stale.type).toBe(STREAM_SESSION_STALE_EVENT)
        expect(stale.data?.sessionID).toBe(background)
        expect(stale.cursor).toBeUndefined()

        // Progress is deliberately cursor-bearing: the renderer skipped all 512
        // payloads, but reconnect must resume *after* them instead of replaying
        // the suppressed flood or falling out of the ring.
        const progress = yield* latestProgressUntilQuiet(reader)
        expect(progress).toBeDefined()
        if (!progress) return yield* Effect.die("missing stream progress")
        expect(progress.type).toBe(STREAM_PROGRESS_EVENT)
        expect(progress.cursor).toMatch(/^[^:]+:\d+$/)
        expect(typeof progress.data?.latest).toBe("number")
        expect(
          yield* expectNoMatchingFrame(
            reader,
            (frame) => frame.type === "session.next.prompt.admitted" && frameSessionID(frame) === background,
          ),
        ).toBe(true)

        const trace = EventTrace.state()
        const suppressedCount = trace.counters["native.interestSuppressed"] ?? 0
        const staleCount = trace.counters["native.interestStaleOffered"] ?? 0
        const progressCount = trace.counters["native.interestProgressOffered"] ?? 0
        const serializedBytes = trace.counters["native.serializeBytes"] ?? 0
        const unsuppressedPayloadBytes = suppressed * 512

        expect(suppressedCount).toBeGreaterThanOrEqual(suppressed)
        expect(staleCount).toBe(1)
        expect(progressCount).toBeGreaterThan(0)
        expect(progressCount).toBeLessThan(suppressed / 2)
        // The exact JSON envelope size can change, so pin a deliberately loose
        // but architectural bound: hundreds of 256-byte deltas may not turn into
        // comparable wire volume once the subscriber has declared no interest.
        expect(serializedBytes).toBeLessThan(unsuppressedPayloadBytes / 6)

        // Promote the background timeline through the real authenticated control
        // endpoint. The existing socket remains open; the next delta must be a
        // domain event, not another stale marker.
        const promoted = yield* requestInDirectory(GlobalPaths.eventInterest, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriber, sessions: [foreground, background] }),
        })
        expect(promoted.status).toBe(200)

        yield* publishPrompt(directory, background, suppressed + 1, "promoted")
        const promotedFrame = yield* readUntil(
          reader,
          (frame) => frame.type === "session.next.prompt.admitted" && frameSessionID(frame) === background,
        )
        expect(promotedFrame.type).toBe("session.next.prompt.admitted")
        expect(promotedFrame.data?.sessionID).toBe(background)

        // Demote it again. The per-session dirty latch must reset when the
        // session was admitted, so a later background era gets one new stale
        // marker and again avoids per-token transport.
        const demoted = yield* requestInDirectory(GlobalPaths.eventInterest, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriber, sessions: [foreground] }),
        })
        expect(demoted.status).toBe(200)

        for (let index = 0; index < 16; index++) yield* publishPrompt(directory, background, suppressed + 2 + index)
        const staleAgain = yield* readUntil(
          reader,
          (frame) => frame.type === STREAM_SESSION_STALE_EVENT && frameSessionID(frame) === background,
        )
        expect(staleAgain.type).toBe(STREAM_SESSION_STALE_EVENT)
        expect(staleAgain.data?.sessionID).toBe(background)
        const progressAgain = yield* latestProgressUntilQuiet(reader)
        expect(progressAgain).toBeDefined()
        if (!progressAgain) return yield* Effect.die("missing second stream progress")
        expect(progressAgain.type).toBe(STREAM_PROGRESS_EVENT)
        expect(
          yield* expectNoMatchingFrame(
            reader,
            (frame) => frame.type === "session.next.prompt.admitted" && frameSessionID(frame) === background,
          ),
        ).toBe(true)
      }).pipe(Effect.timeout("30 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60_000 },
  )

  it.instance(
    "uses suppression progress as the reconnect cursor instead of replaying skipped content",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const foreground = (yield* createSession(directory)).id
        const background = (yield* createSession(directory)).id
        const subscriber = "sub_httpapi_replay_interest"

        const first = yield* openEventStream(directory, subscriber, [foreground])
        expect((yield* readFrame(first)).type).toBe("server.connected")
        yield* drainUntilQuiet(first)
        for (let index = 0; index < 64; index++) yield* publishPrompt(directory, background, index)
        expect(
          (
            yield* readUntil(
              first,
              (frame) => frame.type === STREAM_SESSION_STALE_EVENT && frameSessionID(frame) === background,
            )
          ).type,
        ).toBe(STREAM_SESSION_STALE_EVENT)
        const progress = yield* latestProgressUntilQuiet(first)
        expect(progress).toBeDefined()
        if (!progress) return yield* Effect.die("missing reconnect progress")
        expect(progress.type).toBe(STREAM_PROGRESS_EVENT)
        expect(progress.cursor).toBeDefined()

        const resumed = yield* openEventStream(directory, subscriber, [foreground], progress.cursor)
        expect((yield* readUntil(resumed, (frame) => frame.type === "server.connected")).type).toBe("server.connected")
        // If progress had not advanced Last-Event-ID, this reconnect would now
        // replay stale/progress frames for the 128 suppressed deltas.
        expect(
          yield* expectNoMatchingFrame(
            resumed,
            (frame) =>
              (frame.type === STREAM_SESSION_STALE_EVENT ||
                frame.type === STREAM_PROGRESS_EVENT ||
                frame.type === "session.next.prompt.admitted") &&
              (frameSessionID(frame) === background || frame.type === STREAM_PROGRESS_EVENT),
            "200 millis",
          ),
        ).toBe(true)

        // New background content after reconnect starts a fresh dirty era and is
        // represented compactly again.
        yield* publishPrompt(directory, background, 65)
        expect(
          (
            yield* readUntil(
              resumed,
              (frame) => frame.type === STREAM_SESSION_STALE_EVENT && frameSessionID(frame) === background,
            )
          ).type,
        ).toBe(STREAM_SESSION_STALE_EVENT)
        expect((yield* readUntil(resumed, (frame) => frame.type === STREAM_PROGRESS_EVENT)).type).toBe(
          STREAM_PROGRESS_EVENT,
        )
      }).pipe(Effect.timeout("30 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60_000 },
  )
})

describe("legacy global SSE session interest", () => {
  it.instance(
    "preserves durable sync frames for subscribers that do not advertise interest support",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const session = (yield* createLegacySession(directory)).id
        const part = yield* seedLegacyTextPart(directory, session)
        const { reader } = yield* openLegacyPassThroughStream(directory)
        expect((yield* readLegacyFrame(reader)).payload.type).toBe("server.connected")
        yield* drainLegacyUntilQuiet(reader)

        yield* updateLegacyTextPart(directory, part, "pass-through")
        const sync = yield* readLegacyUntil(reader, (frame) => frame.payload.type === "sync")
        expect(sync.payload.type).toBe("sync")
      }).pipe(Effect.timeout("20 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 40_000 },
  )

  it.instance(
    "keeps sync replay complete across a sync-client disconnect while an interest client holds the generation open",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const foreground = (yield* createLegacySession(directory)).id
        const background = (yield* createLegacySession(directory)).id
        const backgroundPart = yield* seedLegacyTextPart(directory, background)

        // Interest-aware desktop keeps the replay generation/epoch alive but
        // does not itself consume durable sync envelopes.
        const desktop = yield* openLegacyEventStream(directory, "sub_generation_holder", [foreground])
        expect((yield* readLegacyFrame(desktop)).payload.type).toBe("server.connected")
        yield* drainLegacyUntilQuiet(desktop)

        // A pass-through/old subscriber joins the same generation. From this
        // point onward the generation must remain sync-complete even if this
        // stream disconnects temporarily.
        const old = yield* openLegacyPassThroughStream(directory)
        expect((yield* readLegacyFrame(old.reader)).payload.type).toBe("server.connected")
        yield* drainLegacyUntilQuiet(old.reader)

        yield* updateLegacyTextPart(directory, backgroundPart, "before-gap")
        const before = yield* readLegacyUntil(old.reader, (frame) => frame.payload.type === "sync")
        expect(before.cursor).toMatch(/^[^:]+:\d+$/)
        if (!before.cursor) return yield* Effect.fail(new Error("missing sync cursor before reconnect gap"))

        // Fully tear down the old response body while the interest-aware
        // desktop remains connected. This is the load-bearing interval: source
        // sync generation must stay latched even though no current socket wants
        // to receive it.
        yield* Fiber.interrupt(old.fiber)
        yield* updateLegacyTextPart(directory, backgroundPart, "during-gap")

        // The desktop must not receive the duplicate sync representation.
        const desktopWindow = yield* collectLegacyUntilQuiet(desktop)
        expect(desktopWindow.some((frame) => frame.payload.type === "sync")).toBe(false)

        // Reconnect from the old client's last acknowledged cursor. The sync
        // generated while it was absent must be replayable from the SAME epoch,
        // proving the generation-level latch prevented a silent durable hole.
        const resumed = yield* openLegacyPassThroughStream(directory, before.cursor)
        expect((yield* readLegacyUntil(resumed.reader, (frame) => frame.payload.type === "server.connected")).payload.type).toBe(
          "server.connected",
        )
        const replayedSync = yield* readLegacyUntil(resumed.reader, (frame) => frame.payload.type === "sync")
        expect(replayedSync.payload.type).toBe("sync")
        expect(replayedSync.cursor).toMatch(/^[^:]+:\d+$/)
        expect(replayedSync.cursor?.split(":")[0]).toBe(before.cursor.split(":")[0])
      }).pipe(Effect.timeout("30 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60_000 },
  )

  it.instance(
    "suppresses background session content before legacy serialization and supports live promotion",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const foreground = (yield* createLegacySession(directory)).id
        const background = (yield* createLegacySession(directory)).id
        const foregroundPart = yield* seedLegacyTextPart(directory, foreground)
        const backgroundPart = yield* seedLegacyTextPart(directory, background)
        const subscriber = "sub_legacy_httpapi_interest"

        EventTrace.configure({ enabled: true, directory: path.join(os.tmpdir(), "opencode-event-interest-trace") })
        const reader = yield* openLegacyEventStream(directory, subscriber, [foreground])
        expect((yield* readLegacyFrame(reader)).payload.type).toBe("server.connected")
        yield* drainLegacyUntilQuiet(reader)
        EventTrace.reset()

        yield* updateLegacyTextPart(directory, foregroundPart, "foreground")
        const suppressed = 64
        for (let index = 0; index < suppressed; index++) {
          yield* updateLegacyTextPart(directory, backgroundPart, `${index}:${"x".repeat(512)}`)
        }

        const window = yield* collectLegacyUntilQuiet(reader)
        expect(window.some((frame) => frame.payload.type === "sync")).toBe(false)

        const admitted = window.find(
          (frame) => frame.payload.type === "message.part.updated" && legacyFrameSessionID(frame) === foreground,
        )
        if (!admitted) return yield* Effect.fail(new Error("missing foreground legacy part update"))
        expect(legacyFrameSessionID(admitted)).toBe(foreground)

        const stale = window.find(
          (frame) => frame.payload.type === STREAM_SESSION_STALE_EVENT && legacyFrameSessionID(frame) === background,
        )
        if (!stale) return yield* Effect.fail(new Error("missing legacy stale marker"))
        expect(stale.cursor).toBeUndefined()

        const progress = window.findLast((frame) => frame.payload.type === STREAM_PROGRESS_EVENT)
        if (!progress) return yield* Effect.fail(new Error("missing legacy progress marker"))
        expect(progress.cursor).toMatch(/^[^:]+:\d+$/)

        const trace = EventTrace.state()
        // The legacy coalescer may collapse many same-part updates before the
        // subscriber-interest filter sees them. That is strictly better than
        // suppressing each update individually, so pin the semantic invariant
        // (background content reached the filter and was represented by one
        // stale era) rather than requiring N downstream suppression calls.
        expect(trace.counters["global.interestSuppressed"] ?? 0).toBeGreaterThan(0)
        // Desktop-only generations now skip the duplicate durable `sync`
        // envelope in the bridge itself, before it can allocate/broadcast into
        // the legacy subscriber path. The downstream suppression counter should
        // therefore stay at zero while the bridge accounts for the avoided work.
        expect(trace.counters["bridge.syncSkipped"] ?? 0).toBeGreaterThanOrEqual(suppressed)
        expect(trace.counters["global.interestSyncSuppressed"] ?? 0).toBe(0)
        expect(trace.counters["global.interestStaleOffered"] ?? 0).toBe(1)
        expect(trace.counters["global.interestProgressOffered"] ?? 0).toBeGreaterThan(0)
        expect(trace.counters["global.serializeBytes"] ?? 0).toBeLessThan((suppressed * 512) / 4)

        const promoted = yield* requestInDirectory(GlobalPaths.eventInterest, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriber, sessions: [foreground, background] }),
        })
        expect(promoted.status).toBe(200)

        yield* updateLegacyTextPart(directory, backgroundPart, "promoted")
        const promotedFrame = yield* readLegacyUntil(
          reader,
          (frame) =>
            frame.payload.type === "message.part.updated" && legacyFrameSessionID(frame) === background,
        )
        expect(legacyFrameSessionID(promotedFrame)).toBe(background)
      }).pipe(Effect.timeout("30 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60_000 },
  )

  it.instance(
    "advances legacy reconnect cursors across suppressed content and sync envelopes",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const foreground = (yield* createLegacySession(directory)).id
        const background = (yield* createLegacySession(directory)).id
        const backgroundPart = yield* seedLegacyTextPart(directory, background)
        const subscriber = "sub_legacy_replay_interest"

        const first = yield* openLegacyEventStream(directory, subscriber, [foreground])
        expect((yield* readLegacyFrame(first)).payload.type).toBe("server.connected")
        yield* drainLegacyUntilQuiet(first)

        for (let index = 0; index < 16; index++) {
          yield* updateLegacyTextPart(directory, backgroundPart, `${index}:${"x".repeat(128)}`)
        }
        const window = yield* collectLegacyUntilQuiet(first)
        expect(
          window.some(
            (frame) => frame.payload.type === STREAM_SESSION_STALE_EVENT && legacyFrameSessionID(frame) === background,
          ),
        ).toBe(true)
        expect(window.some((frame) => frame.payload.type === "sync")).toBe(false)
        const progress = window.findLast((frame) => frame.payload.type === STREAM_PROGRESS_EVENT)
        expect(progress?.cursor).toMatch(/^[^:]+:\d+$/)
        if (!progress?.cursor) return yield* Effect.fail(new Error("missing legacy replay progress cursor"))

        const resumed = yield* openLegacyEventStream(directory, subscriber, [foreground], progress.cursor)
        expect((yield* readLegacyUntil(resumed, (frame) => frame.payload.type === "server.connected")).payload.type).toBe(
          "server.connected",
        )
        const replay = yield* collectLegacyUntilQuiet(resumed, "200 millis")
        expect(
          replay.some(
            (frame) =>
              frame.payload.type === "sync" ||
              frame.payload.type === STREAM_PROGRESS_EVENT ||
              (frame.payload.type === STREAM_SESSION_STALE_EVENT && legacyFrameSessionID(frame) === background) ||
              (frame.payload.type === "message.part.updated" && legacyFrameSessionID(frame) === background),
          ),
        ).toBe(false)

        yield* updateLegacyTextPart(directory, backgroundPart, "new-dirty-era")
        expect(
          (
            yield* readLegacyUntil(
              resumed,
              (frame) => frame.payload.type === STREAM_SESSION_STALE_EVENT && legacyFrameSessionID(frame) === background,
            )
          ).payload.type,
        ).toBe(STREAM_SESSION_STALE_EVENT)
      }).pipe(Effect.timeout("30 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 60_000 },
  )
})
