import { afterEach, describe, expect, test } from "bun:test"
import {
  clearEventStreamInterestRegistry,
  EVENT_STREAM_SUPPRESSED_CAP,
  eventStreamAllowsSession,
  eventStreamInterestFromHeaders,
  eventStreamInterestRegistrySize,
  markEventStreamSessionSuppressed,
  eventStreamInterestGeneration,
  registerEventStreamInterest,
  unregisterEventStreamInterest,
  updateEventStreamInterest,
} from "./event-interest"
import {
  STREAM_INTEREST_SESSIONS_HEADER,
  STREAM_INTEREST_GENERATION_HEADER,
  STREAM_INTEREST_SUBSCRIBER_HEADER,
} from "@opencode-ai/core/session-stream-content"

afterEach(clearEventStreamInterestRegistry)

describe("event stream interest registry", () => {
  test("out-of-order control cannot overwrite the newest desired state", () => {
    const state = registerEventStreamInterest("sub", ["a"], 0)!
    expect(updateEventStreamInterest("sub", ["c"], 2)).toBe(true)
    expect(updateEventStreamInterest("sub", ["b"], 1)).toBe(false)
    expect(updateEventStreamInterest("sub", ["a"])).toBe(false)
    expect(eventStreamAllowsSession(state, "c")).toBe(true)
    expect(eventStreamAllowsSession(state, "b")).toBe(false)
    expect(eventStreamInterestGeneration("sub")).toBe(2)
  })

  test("a reconnect header fences older outstanding control requests", () => {
    const parsed = eventStreamInterestFromHeaders({
      [STREAM_INTEREST_SUBSCRIBER_HEADER]: "sub",
      [STREAM_INTEREST_SESSIONS_HEADER]: '["c"]',
      [STREAM_INTEREST_GENERATION_HEADER]: "3",
    })!
    const state = registerEventStreamInterest(parsed.subscriber, parsed.sessions, parsed.generation)!
    expect(updateEventStreamInterest("sub", ["b"], 2)).toBe(false)
    expect(eventStreamAllowsSession(state, "c")).toBe(true)
    expect(updateEventStreamInterest("sub", ["c"], 3)).toBe(true)
    expect(updateEventStreamInterest("sub", [], 3)).toBe(false)
    expect(updateEventStreamInterest("sub", [], 4)).toBe(true)
    expect(eventStreamAllowsSession(state, "c")).toBe(false)
  })

  test("invalid revisions cannot mutate registered interest", () => {
    const state = registerEventStreamInterest("sub", ["a"], 0)!
    for (const generation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(updateEventStreamInterest("sub", ["b"], generation)).toBe(false)
    }
    expect(eventStreamAllowsSession(state, "a")).toBe(true)
  })

  test("idempotent retries preserve background dirty latches", () => {
    const state = registerEventStreamInterest("sub", ["a"], 1)!
    expect(markEventStreamSessionSuppressed(state, "b")).toBe(true)
    expect(updateEventStreamInterest("sub", ["a"], 1)).toBe(true)
    expect(markEventStreamSessionSuppressed(state, "b")).toBe(false)
  })
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
