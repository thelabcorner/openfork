import { afterEach, describe, expect, test } from "bun:test"
import {
  clearEventStreamInterestRegistry,
  EVENT_STREAM_SUPPRESSED_CAP,
  eventStreamAllowsSession,
  eventStreamInterestFromHeaders,
  eventStreamInterestRegistrySize,
  markEventStreamSessionSuppressed,
  registerEventStreamInterest,
  unregisterEventStreamInterest,
  updateEventStreamInterest,
} from "./event-interest"
import {
  STREAM_INTEREST_SESSIONS_HEADER,
  STREAM_INTEREST_SUBSCRIBER_HEADER,
} from "@opencode-ai/core/session-stream-content"

afterEach(clearEventStreamInterestRegistry)

describe("event stream interest registry", () => {
  test("old clients without a subscriber remain pass-through", () => {
    expect(eventStreamInterestFromHeaders({})).toBeUndefined()
    expect(eventStreamAllowsSession(undefined, "ses_1")).toBe(true)
  })

  test("parses an explicit empty initial interest set", () => {
    const parsed = eventStreamInterestFromHeaders({
      [STREAM_INTEREST_SUBSCRIBER_HEADER]: "sub_1",
      [STREAM_INTEREST_SESSIONS_HEADER]: "[]",
    })
    expect(parsed).toEqual({ subscriber: "sub_1", sessions: [] })
    const state = registerEventStreamInterest(parsed?.subscriber, parsed?.sessions)
    expect(eventStreamAllowsSession(state, "ses_1")).toBe(false)
  })

  test("emits one dirty latch per background era", () => {
    const state = registerEventStreamInterest("sub", ["ses_active"])!
    expect(markEventStreamSessionSuppressed(state, "ses_bg")).toBe(true)
    expect(markEventStreamSessionSuppressed(state, "ses_bg")).toBe(false)
    expect(updateEventStreamInterest("sub", ["ses_bg"])).toBe(true)
    expect(eventStreamAllowsSession(state, "ses_bg")).toBe(true)
    expect(updateEventStreamInterest("sub", [])).toBe(true)
    expect(markEventStreamSessionSuppressed(state, "ses_bg")).toBe(true)
  })

  test("a reconnect cannot be unregistered by the superseded stream", () => {
    const first = registerEventStreamInterest("sub", [])!
    const second = registerEventStreamInterest("sub", ["ses_2"])!
    unregisterEventStreamInterest(first)
    expect(eventStreamInterestRegistrySize()).toBe(1)
    expect(updateEventStreamInterest("sub", ["ses_3"])).toBe(true)
    expect(eventStreamAllowsSession(second, "ses_3")).toBe(true)
    unregisterEventStreamInterest(second)
    expect(eventStreamInterestRegistrySize()).toBe(0)
  })

  test("bounds stale-marker latches for long-lived subscribers", () => {
    const state = registerEventStreamInterest("sub", [])!
    for (let index = 0; index < EVENT_STREAM_SUPPRESSED_CAP + 128; index++) {
      expect(markEventStreamSessionSuppressed(state, `ses_${index}`)).toBe(true)
    }
    expect(state.suppressed.size).toBe(EVENT_STREAM_SUPPRESSED_CAP)
    expect(state.suppressed.has("ses_0")).toBe(false)
    expect(state.suppressed.has(`ses_${EVENT_STREAM_SUPPRESSED_CAP + 127}`)).toBe(true)
  })
})
