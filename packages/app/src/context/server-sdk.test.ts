import { describe, expect, test } from "bun:test"
import {
  adaptServerEvent,
  coalesceServerEvents,
  createServerEventQueue,
  enqueueServerEvent,
  resumeStreamAfterPageShow,
} from "./server-sdk"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createV2SessionReducer } from "./server-session-v2-reducer"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("adaptServerEvent", () => {
  test("preserves V2 events while adapting permission requests for existing consumers", () => {
    const current = {
      id: "evt_1",
      created: 1,
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "read", resources: ["src/**"] },
    } as OpenCodeEvent

    expect(adaptServerEvent(current)).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm_1", sessionID: "ses_1", permission: "read", patterns: ["src/**"] },
      current,
    })
  })
})

describe("coalesceServerEvents", () => {
  test("32 concurrent streaming sessions retain identical reducer state through bounded batches", () => {
    const queue = createServerEventQueue()
    const expected = new Map<string, SessionMessageInfo[]>()
    const actual = new Map<string, SessionMessageInfo[]>()
    const direct = createV2SessionReducer()
    const batched = createV2SessionReducer()
    let sequence = 0
    const push = (sessionID: string, type: string, data: object) => {
      const event = {
        id: `evt_${sequence++}`,
        created: 1,
        type,
        data: { sessionID, assistantMessageID: `msg_${sessionID}`, ...data },
      } as OpenCodeEvent
      const result = direct.reduce(expected.get(sessionID) ?? [], event)
      if (result) expected.set(sessionID, result.messages)
      queue.push({ directory: "/repo", payload: adaptServerEvent(event) })
    }
    for (let session = 0; session < 32; session++) {
      const id = String(session)
      push(id, "session.step.started", { agent: "build", model: { id: "model", providerID: "provider" } })
      push(id, "session.text.started", { ordinal: 0 })
      push(id, "session.reasoning.started", { ordinal: 1 })
    }
    for (let token = 0; token < 100; token++) {
      for (let session = 0; session < 32; session++) {
        push(String(session), "session.text.delta", { ordinal: 0, delta: `${token} ` })
        push(String(session), "session.reasoning.delta", { ordinal: 1, delta: "reason " })
      }
    }
    while (queue.size) {
      for (const item of queue.take(128)) {
        const event = item.payload.current!
        const id = (event.data as { sessionID: string }).sessionID
        const result = batched.reduce(actual.get(id) ?? [], event)
        if (result) actual.set(id, result.messages)
      }
    }
    expect(actual.size).toBe(32)
    expect(actual).toEqual(expected)
  })

  const currentDelta = (sessionID: string, value: string, type = "session.text.delta") => ({
    directory: "/repo",
    payload: adaptServerEvent({
      id: value,
      created: 1,
      type,
      data: { sessionID, assistantMessageID: "msg", ordinal: 0, delta: value },
    } as OpenCodeEvent),
  })

  test("coalesces concurrent sessions without mixing text and reasoning or mutating inputs", () => {
    const events = [
      currentDelta("a", "1"),
      currentDelta("b", "2"),
      currentDelta("a", "r", "session.reasoning.delta"),
      currentDelta("a", "3"),
    ]
    const before = JSON.stringify(events)
    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.current?.data)).toEqual([
      { sessionID: "a", assistantMessageID: "msg", ordinal: 0, delta: "13" },
      { sessionID: "b", assistantMessageID: "msg", ordinal: 0, delta: "2" },
      { sessionID: "a", assistantMessageID: "msg", ordinal: 0, delta: "r" },
    ])
    expect(JSON.stringify(events)).toBe(before)
  })

  test("keeps start, delta, end and deletion in wire order", () => {
    const boundary = (type: string) => ({
      directory: "/repo",
      payload: adaptServerEvent({ id: type, created: 1, type, data: { sessionID: "a" } } as OpenCodeEvent),
    })
    const events = [
      boundary("session.text.started"),
      currentDelta("a", "1"),
      boundary("session.text.ended"),
      currentDelta("a", "2"),
      boundary("session.deleted"),
    ]
    expect(coalesceServerEvents(events)).toEqual(events)
  })

  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("merges adjacent current text deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", ordinal: 0, delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("merges interleaved deltas for the same part across other-part deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    // "a" and "c" target the same part/field and are separated only by a delta for
    // a DIFFERENT part, so they concatenate into one event (kept at the first
    // occurrence, carrying the last id). The other-part delta stays separate.
    expect(result).toHaveLength(2)
    expect(result[0]?.payload).toMatchObject({ id: "3", properties: { partID: "part", delta: "ac" } })
    expect(result[1]?.payload).toMatchObject({ id: "2", properties: { partID: "other", delta: "b" } })
  })

  test("does not merge deltas across a non-delta barrier", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
    expect(result[0]?.payload).toMatchObject({ properties: { delta: "a" } })
    expect(result[2]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("does not merge deltas across a part snapshot barrier", () => {
    const snapshot = {
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses",
          part: { id: "part", sessionID: "ses", messageID: "msg", type: "text", text: "snapshot" },
        },
      } as Event,
    }
    const result = coalesceServerEvents([delta("a"), snapshot, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.updated",
      "message.part.delta",
    ])
  })
})

describe("enqueueServerEvent", () => {
  test("compacts unread streaming deltas while the renderer is paused", () => {
    const queue = createServerEventQueue()
    for (let i = 0; i < 4096; i++) {
      queue.push({
        directory: "/repo",
        payload: adaptServerEvent({
          id: `evt_${i}`,
          created: i,
          type: "session.text.delta",
          data: { sessionID: "session", assistantMessageID: "message", ordinal: 0, delta: "x" },
        } as OpenCodeEvent),
      })
    }

    expect(queue.size).toBe(1)
    expect(queue.take(128)[0]?.payload.current?.data).toMatchObject({ delta: "x".repeat(4096) })
    expect(queue.size).toBe(0)
  })

  test("drops queued streaming work when the renderer becomes hidden", () => {
    const queue = createServerEventQueue()
    queue.push({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: { sessionID: "session", part: { id: "part", sessionID: "session", messageID: "message", type: "text", text: "live" } },
      } as Event,
    })
    queue.push({
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } } as Event,
    })
    expect(queue.dropWhere((event) => event.payload.type === "message.part.updated")).toBe(1)
    expect(queue.size).toBe(1)
    expect(queue.take(1)[0]?.payload.type).toBe("session.status")
  })

  test("bounds each coalesced delta chunk while preserving the full stream", () => {
    const queue = createServerEventQueue()
    const fragment = "x".repeat(16 * 1024)
    for (let i = 0; i < 5; i++) {
      queue.push({
        directory: "/repo",
        payload: adaptServerEvent({
          id: `evt_${i}`,
          created: i,
          type: "session.text.delta",
          data: { sessionID: "session", assistantMessageID: "message", ordinal: 0, delta: fragment },
        } as OpenCodeEvent),
      })
    }

    const chunks: string[] = []
    while (queue.size) {
      for (const event of queue.take(128)) {
        chunks.push((event.payload.current?.data as { delta: string }).delta)
      }
    }
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true)
    expect(chunks.join("")).toBe(fragment.repeat(5))
  })

  test("bounded drains preserve thousands of ordered lifecycle events across compaction and refill", () => {
    const queue = createServerEventQueue()
    const actual: string[] = []
    const add = (start: number, end: number) => {
      for (let i = start; i < end; i++)
        queue.push({
          directory: "/repo",
          payload: {
            id: String(i),
            type: "session.status",
            properties: { sessionID: String(i % 32), status: { type: "busy" } },
          } as Event,
        })
    }
    add(0, 2048)
    for (let i = 0; i < 10; i++) {
      const events = queue.take(128)
      expect(events).toHaveLength(128)
      actual.push(...events.map((event) => event.payload.id))
    }
    add(2048, 4096)
    while (queue.size) actual.push(...queue.take(128).map((event) => event.payload.id))
    expect(actual).toEqual(Array.from({ length: 4096 }, (_, i) => String(i)))
    add(4096, 4097)
    expect(queue.take(128)[0]?.payload.id).toBe("4096")
    expect(queue.size).toBe(0)
  })

  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
