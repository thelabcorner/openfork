import { expect, test } from "bun:test"
import { adaptLegacyEvent, serializeLegacyEvent } from "../../src/server/event-serialization"

test("shares one adapted object and serialization across legacy subscribers", () => {
  let reads = 0
  const event = Object.freeze({
    id: "same",
    type: "delta",
    data: {
      get text() {
        reads++
        return "content"
      },
    },
  })
  const first = adaptLegacyEvent(event)
  const frame = serializeLegacyEvent(first)
  expect(JSON.parse(frame)).toEqual({ id: "same", type: "delta", properties: { text: "content" } })
  const before = reads
  for (let i = 0; i < 32; i++) {
    expect(adaptLegacyEvent(event)).toBe(first)
    expect(serializeLegacyEvent(adaptLegacyEvent(event))).toBe(frame)
  }
  expect(reads).toBe(before)
})

test("reused IDs do not return an older or differently shaped event", () => {
  const first = { id: "same", type: "delta", properties: { text: "first" } }
  const second = { id: "same", type: "delta", properties: { text: "second" } }
  expect(JSON.parse(serializeLegacyEvent(first))).toEqual(first)
  expect(JSON.parse(serializeLegacyEvent(second))).toEqual(second)
  expect(JSON.parse(serializeLegacyEvent({ payload: second }))).toEqual({ payload: second })
})
