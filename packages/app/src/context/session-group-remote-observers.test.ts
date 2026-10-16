import { expect, test } from "bun:test"
import { createRemoteGroupObservers } from "./session-group-remote-observers"
import { createServerEventLifetime } from "./server-event-lifetime"

test("multiple remote inspectors share one live server listener with reference-counted teardown", async () => {
  const handlers = new Map<string, (type: string) => void>()
  const updates: string[] = []
  let subscriptions = 0
  let unsubscribes = 0
  const observers = createRemoteGroupObservers({
    subscribe: (server, callback) => {
      subscriptions++
      handlers.set(server, callback)
      return () => {
        unsubscribes++
        handlers.delete(server)
      }
    },
    invalidates: (type) => type.startsWith("swarm."),
    onChanged: (server) => updates.push(server),
  })
  const releaseOne = observers.watch("remote")
  const releaseTwo = observers.watch("remote")
  expect(subscriptions).toBe(1)
  handlers.get("remote")?.("session.status")
  handlers.get("remote")?.("swarm.member.updated")
  handlers.get("remote")?.("swarm.updated")
  await Promise.resolve()
  expect(updates).toEqual(["remote"])
  releaseOne()
  expect(unsubscribes).toBe(0)
  handlers.get("remote")?.("swarm.created")
  await Promise.resolve()
  expect(updates).toEqual(["remote", "remote"])
  releaseTwo()
  releaseTwo()
  expect(unsubscribes).toBe(1)
  observers.dispose()
  expect(unsubscribes).toBe(1)
})

test("stale queued refreshes cannot outlive a closed or removed remote inspector", async () => {
  let listener!: (type: string) => void
  const changed: string[] = []
  const observers = createRemoteGroupObservers({
    subscribe: (_server, callback) => {
      listener = callback
      return () => {}
    },
    invalidates: () => true,
    onChanged: (key) => changed.push(key),
  })
  const release = observers.watch("remote")
  listener("swarm.updated")
  release()
  await Promise.resolve()
  expect(changed).toEqual([])
  const releaseNext = observers.watch("remote")
  listener("swarm.member.updated")
  observers.drop("remote")
  await Promise.resolve()
  expect(changed).toEqual([])
  releaseNext()
})

test("disconnected subscriptions degrade safely and cannot keep a stale owner alive", () => {
  const observers = createRemoteGroupObservers({
    subscribe: () => { throw Error("disconnected") },
    invalidates: () => true,
    onChanged: () => { throw Error("unexpected") },
  })
  const stop = observers.watch("remote")
  stop()
  observers.dispose()
})

test("last hover unsubscribe signals cancellation exactly once, but an earlier release does not", () => {
  const cancelled: string[] = []
  const observers = createRemoteGroupObservers({
    subscribe: () => () => {},
    invalidates: () => true,
    onChanged: () => {},
    onUnwatched: (key) => cancelled.push(key),
  })
  const releaseA = observers.watch("remote")
  const releaseB = observers.watch("remote")
  expect(observers.watching("remote")).toBe(true)
  releaseA()
  expect(cancelled).toEqual([])
  releaseB()
  releaseB()
  expect(cancelled).toEqual(["remote"])
  expect(observers.watching("remote")).toBe(false)
})

test("auth/endpoint rotation swaps the transport without releasing live hover leases", async () => {
  const callbacks: Array<(type: string) => void> = []
  let unsubscribeCount = 0
  const events: string[] = []
  const observers = createRemoteGroupObservers({
    subscribe: (_key, callback) => {
      callbacks.push(callback)
      return () => { unsubscribeCount++ }
    },
    invalidates: (type) => type === "swarm.updated",
    onChanged: (key) => events.push(key),
  })
  const a = observers.watch("remote")
  const b = observers.watch("remote")
  callbacks[0]?.("swarm.updated") // queued from previous connection
  observers.refresh("remote")
  expect(callbacks).toHaveLength(2)
  expect(unsubscribeCount).toBe(1)
  expect(observers.watching("remote")).toBe(true)
  await Promise.resolve()
  expect(events).toEqual([])
  callbacks[0]?.("swarm.updated") // an event racing with old unsubscribe
  await Promise.resolve()
  expect(events).toEqual([])
  callbacks[1]?.("swarm.updated")
  callbacks[1]?.("swarm.updated")
  await Promise.resolve()
  expect(events).toEqual(["remote"])
  a()
  expect(observers.watching("remote")).toBe(true)
  b()
  expect(unsubscribeCount).toBe(2)
})

test("cross-tick structural bursts throttle to one server refresh and cancel timers after hover teardown", async () => {
  let dispatch: (type: string) => void = () => {}
  const updated: string[] = []
  const observers = createRemoteGroupObservers({
    subscribe: (_key, callback) => {
      dispatch = callback
      return () => {}
    },
    invalidates: (value) => value === "swarm.member.updated",
    onChanged: (key) => updated.push(key),
    coalesceMs: 15,
  })
  const stop = observers.watch("server")
  for (let i = 0; i < 30; i++) {
    dispatch("swarm.member.updated")
    await Promise.resolve()
  }
  expect(updated).toHaveLength(0)
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(updated).toEqual(["server"])
  dispatch("swarm.member.updated")
  stop()
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(updated).toEqual(["server"])
})

test("actual remote observer leases start a shared stream, dispatch structural events, and tear it down", async () => {
  let opens = 0
  let closes = 0
  const lifetime = createServerEventLifetime({ begin: () => opens++, stop: () => closes++ })
  const callbacks = new Set<(event: string) => void>()
  const changed: string[] = []
  const observers = createRemoteGroupObservers({
    subscribe: (_server, onEvent) => {
      callbacks.add(onEvent)
      const release = lifetime.acquire()
      return () => {
        callbacks.delete(onEvent)
        release()
      }
    },
    invalidates: (event) => event === "swarm.member.updated",
    onChanged: (server) => changed.push(server),
  })
  const releases = Array.from({ length: 100 }, () => observers.watch("remote"))
  expect(opens).toBe(1)
  expect(callbacks.size).toBe(1)
  for (const callback of callbacks) {
    callback("session.updated")
    callback("swarm.member.updated")
  }
  await Promise.resolve()
  expect(changed).toEqual(["remote"])
  for (const release of releases.slice(0, 99)) release()
  expect(closes).toBe(0)
  releases[99]?.()
  expect(callbacks.size).toBe(0)
  expect(closes).toBe(1)
  observers.dispose()
  lifetime.dispose()
  expect(closes).toBe(1)
})