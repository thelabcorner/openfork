import { afterEach, describe, expect } from "bun:test"
import { EventTrace } from "@opencode-ai/core/event-trace"
import { Effect, Queue, Stream } from "effect"
import os from "node:os"
import path from "node:path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

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
          ...(JSON.parse(data.slice("data: ".length)) as { type: string; [key: string]: unknown }),
          cursor: lines.find((line) => line.startsWith("id: "))?.slice(4),
        }
      }
      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("event timeout")) }),
      )
      buffer += decoder.decode(value, { stream: true })
    }
  })

const openEventStream = (directory: string, cursor?: string) =>
  Effect.gen(function* () {
    // Exercise the same native V2 transport used by mobile's `v2.event.subscribe`,
    // not the legacy instance `/event` compatibility route.
    const response = yield* requestInDirectory("/api/event", directory, {
      headers: cursor ? { "Last-Event-ID": cursor } : undefined,
    })
    expect(response.status).toBe(200)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return reader
  })

function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

afterEach(async () => {
  EventTrace.configure({ enabled: false })
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("native SSE fanout fairness", () => {
  it.instance(
    "keeps tiny publish latency bounded with three PWA subscribers plus a desktop subscriber",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        EventTrace.configure({
          enabled: true,
          directory: path.join(os.tmpdir(), "opencode-event-fairness-trace"),
        })

        const subscribers: Queue.Dequeue<Uint8Array>[] = []
        const first = yield* openEventStream(directory)
        subscribers.push(first)
        expect((yield* readFrame(first)).type).toBe("server.connected")

        const baseline: number[] = []
        for (let index = 0; index < 24; index++) {
          const started = performance.now()
          const response = yield* requestInDirectory("/session", directory, { method: "POST" })
          baseline.push(performance.now() - started)
          expect(response.status).toBe(200)
        }

        for (let index = 0; index < 3; index++) {
          const reader = yield* openEventStream(directory)
          subscribers.push(reader)
          expect((yield* readFrame(reader)).type).toBe("server.connected")
        }

        // The response streams are already continuously pulled into the test
        // queues above, so this measures server fanout rather than a deliberately
        // stalled client. Three subscribers model PWAs; the fourth models the
        // desktop renderer consuming the same native EventV2 feed.
        const fanout: number[] = []
        for (let index = 0; index < 48; index++) {
          const started = performance.now()
          const response = yield* requestInDirectory("/session", directory, { method: "POST" })
          fanout.push(performance.now() - started)
          expect(response.status).toBe(200)
        }

        yield* Effect.sleep("100 millis")
        const trace = EventTrace.state()
        const metrics = {
          subscribers: subscribers.length,
          baselineMedianMs: percentile(baseline, 0.5),
          baselineP95Ms: percentile(baseline, 0.95),
          fanoutMedianMs: percentile(fanout, 0.5),
          fanoutP95Ms: percentile(fanout, 0.95),
          offered: trace.counters["native.subscriberOffered"] ?? 0,
          failed: trace.counters["native.subscriberFailed"] ?? 0,
          legacySkipped: trace.counters["bridge.legacySkipped"] ?? 0,
          legacyEnvelopes: trace.counters["bridge.legacyEnvelopes"] ?? 0,
          serialize: trace.timings["native.serializeMs"],
        }
        console.log(`EVENT_FAIRNESS_METRICS=${JSON.stringify(metrics)}`)

        expect(metrics.subscribers).toBe(4)
        expect(metrics.failed).toBe(0)
        expect(metrics.offered).toBeGreaterThanOrEqual(48 * 4)
        expect(metrics.legacySkipped).toBeGreaterThan(0)
        expect(metrics.legacyEnvelopes).toBe(0)
        // This is intentionally a generous regression ceiling: it catches a
        // reintroduced blocking subscriber path without encoding workstation
        // microbenchmark noise into CI.
        expect(metrics.fanoutP95Ms).toBeLessThan(250)
      }).pipe(Effect.timeout("120 seconds")),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 180_000 },
  )
})
