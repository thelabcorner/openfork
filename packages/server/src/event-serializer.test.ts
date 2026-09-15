import { expect, test } from "bun:test"
import { serializeEvent } from "./event-serializer"

test("reuses immutable event frames without confusing distinct payloads with the same ID", () => {
  const first = Object.freeze({ id: "evt_1", type: "server.connected", data: Object.freeze({ epoch: "epoch-a" }) })
  const second = Object.freeze({
    id: "evt_1",
    type: "server.connected",
    data: Object.freeze({ epoch: "epoch-a" }),
    location: { directory: "/other" },
  })
  expect(JSON.parse(serializeEvent(first))).toEqual(first)
  expect(serializeEvent(first)).toBe(serializeEvent(first))
  expect(JSON.parse(serializeEvent(second))).toEqual(second)
})

test("invalid events still fail schema validation", () => {
  expect(() => serializeEvent({ type: "unknown", data: {} })).toThrow()
})

test("validates and serializes native transport control frames", () => {
  const connected = { id: "evt_connected", type: "server.connected", data: { epoch: "epoch-a" } }
  const heartbeat = { id: "evt_heartbeat", type: "server.heartbeat", data: {} }
  const gap = { id: "evt_gap", type: "server.stream.gap", data: { requested: 1, latest: 4 } }
  const stale = { id: "evt_stale", type: "server.stream.session-stale", data: { sessionID: "ses_1" } }
  const progress = { id: "evt_progress", type: "server.stream.progress", data: { latest: 9 } }
  expect(JSON.parse(serializeEvent(connected))).toEqual(connected)
  expect(JSON.parse(serializeEvent(heartbeat))).toEqual(heartbeat)
  expect(JSON.parse(serializeEvent(gap))).toEqual(gap)
  expect(JSON.parse(serializeEvent(stale))).toEqual(stale)
  expect(JSON.parse(serializeEvent(progress))).toEqual(progress)
})

test("additional subscribers do not re-encode the same published object", () => {
  let reads = 0
  const event = Object.freeze({
    id: "evt_shared",
    type: "server.connected",
    get data() {
      reads++
      return { epoch: "epoch-a" }
    },
  })
  const frame = serializeEvent(event)
  const initialReads = reads
  expect(initialReads).toBeGreaterThan(0)
  for (let subscriber = 0; subscriber < 32; subscriber++) expect(serializeEvent(event)).toBe(frame)
  expect(reads).toBe(initialReads)
})
