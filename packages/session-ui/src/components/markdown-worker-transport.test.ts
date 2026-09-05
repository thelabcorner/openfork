import { expect, test } from "bun:test"
import { createWorkerTransport } from "./markdown-worker-transport"

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
