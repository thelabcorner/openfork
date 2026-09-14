import { expect, test } from "bun:test"
import { createWorkerTransport } from "./markdown-worker-transport"

test("defaults to one in-flight request for a serial worker lane", () => {
  const posted: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string }>({
    post: (request) => posted.push(request.id),
    supersede: () => {},
  })

  transport.send({ id: 1, key: "session-a" })
  transport.send({ id: 2, key: "session-b" })
  transport.send({ id: 3, key: "session-c" })
  expect(posted).toEqual([1])
  expect(transport.queued()).toBe(2)

  transport.complete("session-a", 1)
  expect(posted).toEqual([1, 2])
  transport.complete("session-b", 2)
  expect(posted).toEqual([1, 2, 3])
})

test("bounds worker messages and preserves latest queued keys", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string }>({
    maxActive: 1,
    maxQueued: 2,
    post: (request) => posted.push(request.id),
    supersede: (request) => superseded.push(request.id),
  })

  transport.send({ id: 1, key: "a" })
  transport.send({ id: 2, key: "b" })
  transport.send({ id: 3, key: "c" })
  transport.send({ id: 4, key: "d" })
  expect(posted).toEqual([1])
  expect(superseded).toEqual([2])

  transport.complete("a", 1)
  expect(posted).toEqual([1, 3])
  transport.complete("c", 3)
  expect(posted).toEqual([1, 3, 4])
})

test("replacing an active key supersedes only its queued predecessor", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string }>({
    maxActive: 1,
    post: (request) => posted.push(request.id),
    supersede: (request) => superseded.push(request.id),
  })

  transport.send({ id: 1, key: "a" })
  transport.send({ id: 2, key: "a" })
  transport.send({ id: 3, key: "a" })
  expect(superseded).toEqual([2])
  transport.complete("a", 1)
  expect(posted).toEqual([1, 3])
})

test("replacing a waiting key rejects the old request instead of orphaning it", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string }>({
    maxActive: 1,
    maxQueued: 2,
    post: (request) => posted.push(request.id),
    supersede: (request) => superseded.push(request.id),
  })

  transport.send({ id: 1, key: "active" })
  transport.send({ id: 2, key: "same" })
  transport.send({ id: 3, key: "same" })
  expect(superseded).toEqual([2])
  expect(transport.queued()).toBe(1)

  transport.complete("active", 1)
  expect(posted).toEqual([1, 3])
})

test("runs separate serial worker lanes concurrently without posting two jobs to one lane", () => {
  const posted: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string; lane: number }>({
    maxActive: 2,
    maxActivePerLane: 1,
    laneOf: (request) => request.lane,
    post: (request) => posted.push(request.id),
    supersede: () => {},
  })

  transport.send({ id: 1, key: "lane-0-a", lane: 0 })
  transport.send({ id: 2, key: "lane-0-b", lane: 0 })
  transport.send({ id: 3, key: "lane-1-a", lane: 1 })

  expect(posted).toEqual([1, 3])
  expect(transport.queued()).toBe(1)

  transport.complete("lane-1-a", 3)
  // Lane 0 is still occupied, so completing lane 1 must not push another job
  // into the already-busy worker merely because a global slot is available.
  expect(posted).toEqual([1, 3])

  transport.complete("lane-0-a", 1)
  expect(posted).toEqual([1, 3, 2])
})

test("keeps a waiting request supersedable while its worker lane is busy", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const transport = createWorkerTransport<{ id: number; key: string; lane: number }>({
    maxActive: 2,
    maxActivePerLane: 1,
    laneOf: (request) => request.lane,
    post: (request) => posted.push(request.id),
    supersede: (request) => superseded.push(request.id),
  })

  transport.send({ id: 1, key: "active", lane: 0 })
  transport.send({ id: 2, key: "waiting", lane: 0 })
  transport.send({ id: 3, key: "waiting", lane: 0 })

  expect(posted).toEqual([1])
  expect(superseded).toEqual([2])
  transport.complete("active", 1)
  expect(posted).toEqual([1, 3])
})
