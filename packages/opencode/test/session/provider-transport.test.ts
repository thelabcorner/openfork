import { expect, test } from "bun:test"
import { abortSessionTransports, registerProviderTransport } from "../../src/session/llm/provider-transport"

test("host cancellation affects only controllers registered to the exact Session", () => {
  const first = new AbortController()
  const second = new AbortController()
  const neighbor = new AbortController()
  const releaseFirst = registerProviderTransport("session-transport-A", first)
  const releaseSecond = registerProviderTransport("session-transport-A", second)
  const releaseNeighbor = registerProviderTransport("session-transport-B", neighbor)
  try {
    expect(abortSessionTransports("session-transport-A")).toBe(2)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(neighbor.signal.aborted).toBe(false)
    expect(abortSessionTransports("session-transport-A")).toBe(0)
    expect(abortSessionTransports("session-transport-B")).toBe(1)
    expect(neighbor.signal.aborted).toBe(true)
  } finally {
    releaseFirst()
    releaseSecond()
    releaseNeighbor()
  }
  expect(abortSessionTransports("session-transport-A")).toBe(0)
  expect(abortSessionTransports("session-transport-B")).toBe(0)
})

test("closing an old attempt cannot unregister a newly registered attempt", () => {
  const old = new AbortController()
  const releaseOld = registerProviderTransport("session-transport-restart", old)
  const next = new AbortController()
  const releaseNext = registerProviderTransport("session-transport-restart", next)
  releaseOld()
  releaseOld()
  expect(abortSessionTransports("session-transport-restart")).toBe(1)
  expect(old.signal.aborted).toBe(false)
  expect(next.signal.aborted).toBe(true)
  releaseNext()
  expect(abortSessionTransports("session-transport-restart")).toBe(0)
})

test("1/3/6 concurrent Sessions preserve isolation and bounded registry cleanup", () => {
  for (const count of [1, 3, 6]) {
    const entries = Array.from({ length: count }, (_, i) => {
      const sessionID = `session-transport-load-${count}-${i}`
      const controller = new AbortController()
      const release = registerProviderTransport(sessionID, controller)
      return { sessionID, controller, release }
    })
    for (let i = 0; i < entries.length; i++) {
      if (i % 2 === 0) expect(abortSessionTransports(entries[i]!.sessionID)).toBe(1)
    }
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i]!.controller.signal.aborted).toBe(i % 2 === 0)
      entries[i]!.release()
      expect(abortSessionTransports(entries[i]!.sessionID)).toBe(0)
    }
  }
})

test("transport registry is discoverable by another module instance in the same process", () => {
  const sessionID = "session-transport-symbol-registry"
  const controller = new AbortController()
  const release = registerProviderTransport(sessionID, controller)
  try {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("openfork.session.provider-transports.v1")]
    expect(registry).toBeInstanceOf(Map)
    expect((registry as Map<string, Set<AbortController>>).get(sessionID)?.has(controller)).toBe(true)
  } finally {
    release()
  }
  expect(abortSessionTransports(sessionID)).toBe(0)
})

test("2,048 attempt registrations under 32 Session IDs leave no stale registry entries", () => {
  const releases: Array<() => void> = []
  const prefix = "session-provider-transport-2048-"
  for (let i = 0; i < 2_048; i++) {
    const sessionID = `${prefix}${i % 32}`
    releases.push(registerProviderTransport(sessionID, new AbortController()))
  }
  for (let index = 0; index < 32; index++) {
    const sessionID = `${prefix}${index}`
    expect(abortSessionTransports(sessionID)).toBe(64)
    expect(abortSessionTransports(sessionID)).toBe(0)
  }
  // Releasing out of acquisition order is the normal overlap pattern.
  for (let i = releases.length - 1; i >= 0; i--) releases[i]!()
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("openfork.session.provider-transports.v1")]
  const stillPresent = [...(registry as Map<string, Set<AbortController>>).keys()].filter((id) => id.startsWith(prefix))
  expect(stillPresent).toEqual([])
})
