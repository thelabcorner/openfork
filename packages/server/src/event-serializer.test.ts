import { expect, test } from "bun:test"
import { serializeEvent } from "./event-serializer"

test("reuses immutable event frames without confusing distinct payloads with the same ID", () => {
  const first = Object.freeze({ id: "evt_1", type: "server.connected", data: Object.freeze({}) })
  const second = Object.freeze({
    id: "evt_1",
    type: "server.connected",
    data: Object.freeze({}),
    location: { directory: "/other" },
  })
  expect(JSON.parse(serializeEvent(first))).toEqual(first)
  expect(serializeEvent(first)).toBe(serializeEvent(first))
  expect(JSON.parse(serializeEvent(second))).toEqual(second)
})

test("invalid events still fail schema validation", () => {
  expect(() => serializeEvent({ type: "unknown", data: {} })).toThrow()
})

test("serializes replay gap control frames without domain validation", () => {
  const event = { id: "evt_gap", type: "server.stream.gap", data: { requested: 1, latest: 4 } }
  expect(JSON.parse(serializeEvent(event))).toEqual(event)
})

test("additional subscribers do not re-encode the same published object", () => {
  let reads = 0
  const event = Object.freeze({
    id: "evt_shared",
    type: "server.connected",
    get data() {
      reads++
      return {}
    },
  })
  const frame = serializeEvent(event)
  const initialReads = reads
  expect(initialReads).toBeGreaterThan(0)
  for (let subscriber = 0; subscriber < 32; subscriber++) expect(serializeEvent(event)).toBe(frame)
  expect(reads).toBe(initialReads)
})
