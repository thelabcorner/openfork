import { expect, test } from "bun:test"
import { createServerEventLifetime } from "./server-event-lifetime"

test("two committed remote inspectors share exactly one live stream and stop on last close", () => {
  let opens = 0
  let closes = 0
  const lifetime = createServerEventLifetime({ begin: () => opens++, stop: () => closes++ })
  const first = lifetime.acquire()
  const second = lifetime.acquire()
  expect(opens).toBe(1)
  first()
  expect(closes).toBe(0)
  second()
  second()
  expect(closes).toBe(1)
  lifetime.dispose()
  expect(closes).toBe(1)
})

test("ServerSync permanent ownership survives a remote inspector's final release", () => {
  let begins = 0
  let stops = 0
  const lifetime = createServerEventLifetime({ begin: () => begins++, stop: () => stops++ })
  const hover = lifetime.acquire()
  lifetime.pin()
  hover()
  expect(begins).toBe(1)
  expect(stops).toBe(0)
  lifetime.pagehide()
  expect(stops).toBe(1)
  lifetime.pageshow()
  expect(begins).toBe(2)
  lifetime.dispose()
  expect(stops).toBe(2)
})

test("unowned SDK does not resurrect a closed hover stream on BFCache pageshow", () => {
  let begins = 0
  let stops = 0
  const lifetime = createServerEventLifetime({ begin: () => begins++, stop: () => stops++ })
  const release = lifetime.acquire()
  lifetime.pagehide()
  lifetime.pageshow()
  expect(begins).toBe(2)
  release()
  lifetime.pagehide()
  lifetime.pageshow()
  expect(begins).toBe(2)
  expect(stops).toBe(2)
  lifetime.dispose()
  const ignored = lifetime.acquire()
  lifetime.pin()
  lifetime.pageshow()
  ignored()
  expect(begins).toBe(2)
})

test("SessionSync teardown retains an active remote inspector; only the final lease stops SSE", () => {
  let opens = 0
  let stops = 0
  const lifetime = createServerEventLifetime({ begin: () => opens++, stop: () => stops++ })
  const sessionSync = lifetime.acquire()
  const hover = lifetime.acquire()
  expect(opens).toBe(1)
  sessionSync()
  expect(stops).toBe(0)
  hover()
  expect(stops).toBe(1)
  const reopened = lifetime.acquire()
  expect(opens).toBe(2)
  reopened()
  expect(stops).toBe(2)
  lifetime.dispose()
})