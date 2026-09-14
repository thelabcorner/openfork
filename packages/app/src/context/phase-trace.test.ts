import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { phaseTrace } from "./phase-trace"

describe("phase trace", () => {
  beforeEach(() => {
    phaseTrace.configure(true)
    phaseTrace.reset()
  })

  afterEach(() => {
    phaseTrace.reset()
    phaseTrace.configure(false)
  })

  test("frames, reducer and projection costs accumulate per window", () => {
    phaseTrace.frame("message.part.delta", "ses-1")
    phaseTrace.frame("server.heartbeat")
    phaseTrace.reducer("applyV2", 2, "ses-1")
    phaseTrace.projection(3, 320)
    phaseTrace.row("turn-1", 1)
    const snap = phaseTrace.snapshot()
    expect(snap.current.frames).toBe(2)
    expect(snap.current.applyV2Ms).toBe(2)
    expect(snap.current.projectionMs).toBe(3)
    expect(snap.current.projectionTurns).toBe(320)
    expect(snap.current.rowsBuilt).toBe(1)
    expect(snap.kinds["message.part.delta"]).toBe(1)
    expect(snap.sessions["ses-1"]).toBe(2)
  })

  test("only slow rows reach the ring", () => {
    phaseTrace.row("fast", 1)
    phaseTrace.row("slow", 30)
    const snap = phaseTrace.snapshot()
    expect(snap.current.rowsBuilt).toBe(2)
    expect(snap.current.slowRows).toBe(1)
    expect(snap.recent.length).toBe(1)
    expect((snap.recent[0] as { key: string }).key).toBe("slow")
  })

  test("histograms cap distinct keys and spill into other", () => {
    for (let index = 0; index < 70; index++) phaseTrace.frame(`type-${index}`)
    const snap = phaseTrace.snapshot()
    expect(Object.keys(snap.kinds).length).toBeLessThanOrEqual(65)
    expect(snap.kinds["other"]).toBe(6)
  })

  test("reconnects and gaps are recorded as rare events", () => {
    phaseTrace.reconnect({ failures: 2 })
    phaseTrace.gap({ requested: 1, latest: 10 })
    const snap = phaseTrace.snapshot()
    expect(snap.current.reconnects).toBe(1)
    expect(snap.current.gaps).toBe(1)
    expect(snap.recent.length).toBe(2)
  })

  test("records markdown DOM and worker costs", () => {
    phaseTrace.markdown({ phase: "paced", chars: 120, streaming: true })
    phaseTrace.markdown({ phase: "effect", ms: 30, textChars: 120, blockCount: 1, streaming: true })
    phaseTrace.markdown({
      phase: "block",
      ms: 28,
      action: "morph",
      mode: "live",
      chars: 120,
      innerHTMLMs: 8,
      morphMs: 12,
    })
    phaseTrace.markdown({ phase: "sanitize", ms: 3, chars: 120, htmlChars: 150 })
    phaseTrace.markdown({
      phase: "worker",
      kind: "project",
      status: "ok",
      ms: 14,
      chars: 120,
      workerMs: 4,
      workerQueueMs: 2,
      dispatchWaitMs: 7,
      responseWaitMs: 7,
    })
    phaseTrace.markdown({
      phase: "worker",
      kind: "parse",
      status: "ok",
      ms: 5,
      chars: 64,
      workerMs: 2,
      incremental: true,
    })
    phaseTrace.markdown({
      phase: "worker",
      kind: "parse",
      status: "ok",
      ms: 6,
      chars: 128,
      workerMs: 3,
      incremental: false,
    })
    const snap = phaseTrace.snapshot()
    expect(snap.current.markdown.pacedUpdates).toBe(1)
    expect(snap.current.markdown.effectMs).toBe(30)
    expect(snap.current.markdown.blockMs).toBe(28)
    expect(snap.current.markdown.innerHTMLMs).toBe(8)
    expect(snap.current.markdown.morphMs).toBe(12)
    expect(snap.current.markdown.sanitizeCalls).toBe(1)
    expect(snap.current.markdown.sanitizeMs).toBe(3)
    expect(snap.current.markdown.workerComputeMs).toBe(9)
    expect(snap.current.markdown.workerInternalQueueMs).toBe(2)
    expect(snap.current.markdown.workerQueueMs).toBe(16)
    expect(snap.current.markdown.workerDispatchWaitMs).toBe(7)
    expect(snap.current.markdown.workerResponseWaitMs).toBe(7)
    expect(snap.current.markdown.workerByKind["project.ok"]).toBe(1)
    expect(snap.current.markdown.workerByKind["parse.ok"]).toBe(2)
    expect(snap.current.markdown.parseIncremental).toBe(1)
    expect(snap.current.markdown.parseFull).toBe(1)
    expect(snap.current.markdown.parseUnknown).toBe(0)
    expect(snap.recent.map((entry) => entry.phase)).toEqual(["markdown.effect.slow", "markdown.block.slow"])
  })
})
