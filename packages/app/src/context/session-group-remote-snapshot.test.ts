import { expect, test } from "bun:test"
import { createRemoteSessionGroupSnapshots } from "./session-group-remote-snapshot"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("many inactive-server hovers share one cold flight and reuse a fresh snapshot", async () => {
  let clock = 1_000
  let requested = 0
  const first = deferred<string>()
  const data = new Map<string, string>()
  const snapshots = createRemoteSessionGroupSnapshots({
    load: async () => { requested++; return first.promise },
    publish: (key, value) => data.set(key, value),
    now: () => clock,
    freshnessMs: 5_000,
    retryMs: 100,
  })
  for (let i = 0; i < 100; i++) snapshots.ensure("remote")
  expect(requested).toBe(1)
  first.resolve("workers")
  await flush()
  expect(data.get("remote")).toBe("workers")
  clock += 4_000
  snapshots.ensure("remote")
  expect(requested).toBe(1)
  snapshots.dispose()
})

test("per-server generations prevent removed connections and late responses from resurrecting old groups", async () => {
  const responses = new Map<string, ReturnType<typeof deferred<string>>[]>()
  const received = new Map<string, string>()
  const snapshots = createRemoteSessionGroupSnapshots({
    load: (key) => {
      const pending = deferred<string>()
      const list = responses.get(key) ?? []
      list.push(pending)
      responses.set(key, list)
      return pending.promise
    },
    publish: (key, value) => received.set(key, value),
    now: () => 10,
    freshnessMs: 0,
    retryMs: 0,
  })
  snapshots.ensure("local")
  snapshots.ensure("remote")
  snapshots.forget("local")
  snapshots.ensure("local")
  responses.get("local")?.[0]?.resolve("stale-local")
  responses.get("remote")?.[0]?.resolve("real-remote")
  responses.get("local")?.[1]?.resolve("current-local")
  await flush()
  expect(received.get("local")).toBe("current-local")
  expect(received.get("remote")).toBe("real-remote")
  snapshots.dispose()
})

test("failures back off without blocking other servers and dispose drops pending completions", async () => {
  let clock = 100
  let attempts = 0
  const received: string[] = []
  const pending = deferred<string>()
  const snapshots = createRemoteSessionGroupSnapshots({
    load: (key) => {
      attempts++
      return key === "error" ? Promise.reject(Error("connection offline")) : pending.promise
    },
    publish: (_key, value) => received.push(value),
    now: () => clock,
    freshnessMs: 1000,
    retryMs: 15,
  })
  snapshots.ensure("error")
  await flush()
  snapshots.ensure("error")
  expect(attempts).toBe(1)
  clock += 16
  snapshots.ensure("error")
  expect(attempts).toBe(2)
  snapshots.ensure("healthy")
  snapshots.dispose()
  pending.resolve("late-data")
  await flush()
  expect(received).toEqual([])
})

test("last-hover cancellation invalidates a legacy fetch generation and prevents stale publication", async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let calls = 0
  let firstValid: (() => boolean) | undefined
  const received: string[] = []
  const snapshots = createRemoteSessionGroupSnapshots({
    load: (_key, valid) => {
      calls++
      if (calls === 1) {
        firstValid = valid
        return first.promise
      }
      return second.promise
    },
    publish: (_key, value) => received.push(value),
    now: () => 100,
    retryMs: 0,
  })
  snapshots.ensure("remote")
  expect(snapshots.pending("remote")).toBe(true)
  expect(firstValid?.()).toBe(true)
  snapshots.forget("remote")
  expect(snapshots.pending("remote")).toBe(false)
  expect(firstValid?.()).toBe(false)
  snapshots.ensure("remote")
  expect(calls).toBe(2)
  first.resolve("retired-data")
  second.resolve("fresh-data")
  await flush()
  expect(received).toEqual(["fresh-data"])
  snapshots.dispose()
})

test("structural event storms keep one physical HTTP flight per remote server and publish only latest result", async () => {
  const requests: ReturnType<typeof deferred<string>>[] = []
  const published: string[] = []
  const snapshots = createRemoteSessionGroupSnapshots({
    load: () => {
      const request = deferred<string>()
      requests.push(request)
      return request.promise
    },
    publish: (_key, value) => published.push(value),
    now: () => 1_000,
    freshnessMs: 0,
    retryMs: 0,
  })
  snapshots.ensure("remote")
  for (let i = 0; i < 10_000; i++) snapshots.refresh("remote")
  expect(requests).toHaveLength(1)
  expect(snapshots.pending("remote")).toBe(true)
  requests[0]?.resolve("obsolete-first")
  await flush()
  expect(requests).toHaveLength(2)
  expect(published).toEqual([])
  for (let i = 0; i < 10_000; i++) snapshots.refresh("remote")
  expect(requests).toHaveLength(2)
  requests[1]?.resolve("obsolete-second")
  await flush()
  expect(requests).toHaveLength(3)
  requests[2]?.resolve("current")
  await flush()
  expect(published).toEqual(["current"])
  expect(snapshots.pending("remote")).toBe(false)
  snapshots.dispose()
})

test("last-hover teardown cancels an event-dirty successor rather than restarting HTTP after close", async () => {
  const request = deferred<string>()
  let calls = 0
  const snapshots = createRemoteSessionGroupSnapshots({
    load: () => { calls++; return request.promise },
    publish: () => { throw Error("retired snapshot published") },
    now: () => 1_000,
  })
  snapshots.ensure("remote")
  snapshots.refresh("remote")
  snapshots.forget("remote")
  request.resolve("stale")
  await flush()
  expect(calls).toBe(1)
  expect(snapshots.pending("remote")).toBe(false)
  snapshots.dispose()
})