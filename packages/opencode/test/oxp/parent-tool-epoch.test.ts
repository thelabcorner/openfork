import { describe, expect, test } from "bun:test"
import { OxpParentToolEpoch } from "@/oxp/parent-tool-epoch"

const chat = (value: string) =>
  ({
    scheme: "openai/session",
    value,
    scope: "conversation",
  }) as const

describe("OXP parent tool epochs", () => {
  test("does not renew the epoch on calls and emits the handoff reminder once at 20 minutes", () => {
    let now = 0
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    const session = chat("chatgpt-parent-a")

    const first = tracker.observe(session)
    expect(first).toMatchObject({ state: "active", epoch: 1, observedAgeMs: 0, shouldRemind: false })

    now = 5 * 60 * 1000
    expect(tracker.observe(session)).toMatchObject({ epoch: 1, observedAgeMs: 5 * 60 * 1000, shouldRemind: false })
    now = 10 * 60 * 1000
    expect(tracker.observe(session)).toMatchObject({ epoch: 1, observedAgeMs: 10 * 60 * 1000, shouldRemind: false })
    now = 19 * 60 * 1000
    expect(tracker.observe(session)).toMatchObject({ epoch: 1, observedAgeMs: 19 * 60 * 1000, shouldRemind: false })

    now = OxpParentToolEpoch.HANDOFF_AFTER_MS
    expect(tracker.observe(session)).toMatchObject({
      state: "handoff-recommended",
      epoch: 1,
      observedAgeMs: OxpParentToolEpoch.HANDOFF_AFTER_MS,
      shouldRemind: true,
    })
    now += 30_000
    expect(tracker.observe(session)).toMatchObject({ epoch: 1, shouldRemind: false })
    expect(tracker.stats()).toMatchObject({ parentEpochs: 1, parentEpochReminders: 1, trackedParents: 1 })
  })

  test("a successful post-25-minute observation begins a new epoch", () => {
    let now = 100
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    const session = chat("chatgpt-parent-a")
    tracker.observe(session)
    now += OxpParentToolEpoch.EPOCH_MAX_MS
    expect(tracker.observe(session)).toMatchObject({
      state: "active",
      epoch: 2,
      observedAgeMs: 0,
      shouldRemind: false,
    })
    expect(tracker.stats().parentEpochs).toBe(2)
  })

  test("tracks parent conversations independently and never invents identity when correlation is absent", () => {
    let now = 0
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    tracker.observe(chat("parent-a"))
    now = OxpParentToolEpoch.HANDOFF_AFTER_MS
    expect(tracker.observe(chat("parent-a"))).toMatchObject({ shouldRemind: true, epoch: 1 })
    expect(tracker.observe(chat("parent-b"))).toMatchObject({ shouldRemind: false, epoch: 1, observedAgeMs: 0 })
    expect(tracker.observe(undefined)).toEqual({ state: "unattributed", shouldRemind: false })
    expect(tracker.stats()).toMatchObject({
      parentEpochs: 2,
      conversationCorrelatedCalls: 3,
      unattributedParentCalls: 1,
      trackedParents: 2,
    })
  })

  test("durable continuation is advisory state within an epoch and resets on rollover", () => {
    let now = 0
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    const session = chat("parent-a")
    tracker.observe(session)
    expect(tracker.markDurableContinuation(session)).toBe(true)
    expect(tracker.hasDurableContinuation(session)).toBe(true)
    now = OxpParentToolEpoch.HANDOFF_AFTER_MS
    expect(tracker.observe(session)).toMatchObject({ shouldRemind: true, durableContinuationEstablished: true })
    now = OxpParentToolEpoch.EPOCH_MAX_MS
    expect(tracker.observe(session)).toMatchObject({ epoch: 2, durableContinuationEstablished: false })
    expect(tracker.hasDurableContinuation(session)).toBe(false)
  })

  test("uses only documented ChatGPT conversation metadata for parent correlation", () => {
    expect(
      OxpParentToolEpoch.parentCorrelation({
        "openai/session": "conversation-a",
      }),
    ).toEqual(chat("conversation-a"))
    expect(
      OxpParentToolEpoch.parentCorrelation({
        "openai/session": "x".repeat(1025),
      }),
    ).toBeUndefined()
    expect(OxpParentToolEpoch.parentCorrelation({})).toBeUndefined()
    expect(
      OxpParentToolEpoch.parentCorrelation(
        { "openai/subject": "same-user-across-conversations" },
      ),
    ).toBeUndefined()
  })

  test("bounds untrusted correlation identifiers and retained parent cardinality", () => {
    let now = 0
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    expect(
      OxpParentToolEpoch.parentCorrelation({
        "openai/session": "x".repeat(1025),
      }),
    ).toBeUndefined()
    tracker.observe(undefined)
    for (let index = 0; index < 300; index++) {
      now += 1
      tracker.observe(chat("parent-" + index))
    }
    expect(tracker.stats().trackedParents).toBeLessThanOrEqual(256)
  })

  test("counts correlation sources without retaining raw identifiers", () => {
    const tracker = OxpParentToolEpoch.makeTracker()
    tracker.observe(chat("conversation-a"))
    tracker.observe(chat("conversation-a"))
    tracker.observe(undefined)
    const stats = tracker.stats()
    expect(stats).toMatchObject({
      conversationCorrelatedCalls: 2,
      unattributedParentCalls: 1,
      trackedParents: 1,
    })
    expect(JSON.stringify(stats)).not.toContain("conversation-a")
  })
})
