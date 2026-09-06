import { afterEach, describe, expect, test } from "bun:test"
import { EventTrace } from "../src/event-trace"

describe("event trace", () => {
  afterEach(() => {
    EventTrace.configure({ enabled: true })
    EventTrace.reset()
  })

  test("counts, sums and timings accumulate in the window snapshot", () => {
    EventTrace.configure({ directory: `${process.env.TMPDIR ?? "/tmp"}/opencode-event-trace-test`, enabled: true })
    EventTrace.count("queue.offered", 2)
    EventTrace.sum("queue.offeredBytes", 100)
    EventTrace.timing("serializeMs", 4)
    EventTrace.timing("serializeMs", 6)
    const state = EventTrace.state()
    expect(state.counters["queue.offered"]).toBe(2)
    expect(state.counters["queue.offeredBytes"]).toBe(100)
    expect(state.timings["serializeMs"].count).toBe(2)
    expect(state.timings["serializeMs"].avgMs).toBe(5)
    expect(state.timings["serializeMs"].maxMs).toBe(6)
  })

  test("histograms cap distinct keys and spill into other", () => {
    for (let index = 0; index < 70; index++) EventTrace.histogram("bridge.type", `type-${index}`)
    const state = EventTrace.state()
    const buckets = state.histograms["bridge.type"]
    expect(Object.keys(buckets).length).toBeLessThanOrEqual(65)
    expect(buckets["other"]).toBe(6)
  })

  test("rare-event ring is bounded", () => {
    for (let index = 0; index < 300; index++) EventTrace.event({ phase: "queue.overflow", capacity: 1 })
    expect(EventTrace.state().recent.length).toBe(256)
  })

  test("disabled tracing records nothing", () => {
    EventTrace.configure({ enabled: false })
    EventTrace.count("queue.offered")
    EventTrace.timing("serializeMs", 1)
    EventTrace.histogram("bridge.type", "x")
    EventTrace.event({ phase: "queue.overflow" })
    const state = EventTrace.state()
    expect(state.counters).toEqual({})
    expect(state.timings).toEqual({})
    expect(state.histograms).toEqual({})
    expect(state.recent).toEqual([])
  })
})
