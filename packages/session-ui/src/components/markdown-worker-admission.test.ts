import { expect, test } from "bun:test"
import { createMarkdownWorkerAdmission, markdownLaneForPriority } from "./markdown-worker-admission"

type Request = { id: number; key: string; type: "parse" | "project" | "highlight" }

function request(id: number, key: string, type: Request["type"] = "parse"): Request {
  return { id, key, type }
}

test("one lane serializes all request kinds and admits the visible tail first", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({ lanes: 1 })
  const send = (value: Request, priority: "background" | "visible" | "tail") =>
    admission.send(value, {
      lane: 0,
      kind: value.type,
      priority,
      bytes: 1,
      post: (item) => posted.push(item.id),
      supersede: (item) => superseded.push(item.id),
    })

  send(request(1, "history", "parse"), "visible")
  send(request(2, "old-tail", "project"), "background")
  send(request(3, "live", "highlight"), "tail")
  expect(posted).toEqual([1])
  expect(admission.snapshot()).toEqual({ queued: 2, queuedBytes: 2, active: 1, activeBytes: 1 })

  admission.complete(1)
  expect(posted).toEqual([1, 3])
  admission.complete(3)
  expect(posted).toEqual([1, 3, 2])
  expect(superseded).toEqual([])
})

test("queued same-kind updates coalesce to the latest request across transports", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({ lanes: 1 })
  const send = (value: Request) =>
    admission.send(value, {
      lane: 0,
      kind: value.type,
      priority: "tail",
      bytes: 1,
      post: (item) => posted.push(item.id),
      supersede: (item) => superseded.push(item.id),
    })

  send(request(1, "active", "parse"))
  send(request(2, "tail", "parse"))
  send(request(3, "tail", "parse"))
  send(request(4, "tail", "project"))
  expect(superseded).toEqual([2])
  admission.complete(1)
  expect(posted).toEqual([1, 3])
  admission.complete(3)
  expect(posted).toEqual([1, 3, 4])
})

test("tail admissions yield to waiting visible work and byte limits evict queued background", () => {
  let time = 0
  const posted: number[] = []
  const superseded: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({
    lanes: 1,
    maxQueued: 8,
    maxQueuedBytes: 4,
    now: () => time,
  })
  const send = (value: Request, priority: "background" | "visible" | "tail", bytes = 1) =>
    admission.send(value, {
      lane: 0,
      kind: value.type,
      priority,
      bytes,
      post: (item) => posted.push(item.id),
      supersede: (item) => superseded.push(item.id),
    })

  send(request(1, "active"), "tail")
  send(request(2, "background"), "background", 3)
  send(request(3, "latest"), "tail", 3)
  expect(superseded).toEqual([2])
  send(request(4, "ordinary", "project"), "visible")
  time = 800
  admission.complete(1)
  expect(posted).toEqual([1, 3])
  admission.complete(3)
  expect(posted).toEqual([1, 3, 4])
})

test("aged visible work receives service after a bounded tail burst", () => {
  let time = 0
  const posted: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({ lanes: 1, now: () => time })
  const send = (value: Request, priority: "background" | "visible" | "tail") =>
    admission.send(value, {
      lane: 0,
      kind: value.type,
      priority,
      bytes: 1,
      post: (item) => posted.push(item.id),
      supersede: () => {},
    })

  send(request(1, "active"), "tail")
  for (let id = 2; id <= 6; id++) send(request(id, `tail-${id}`), "tail")
  send(request(7, "visible", "project"), "visible")
  for (let id = 1; id <= 3; id++) admission.complete(id)
  time = 800
  admission.complete(4)
  expect(posted).toEqual([1, 2, 3, 4, 7])
})

test("rejects a single request above the per-job byte bound", () => {
  const superseded: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({ lanes: 1, maxJobBytes: 2 })
  const accepted = admission.send(request(1, "jumbo"), {
    lane: 0,
    kind: "parse",
    priority: "tail",
    bytes: 3,
    post: () => {},
    supersede: (item) => superseded.push(item.id),
  })
  expect(accepted).toBe(false)
  expect(superseded).toEqual([1])
  expect(admission.snapshot()).toEqual({ queued: 0, queuedBytes: 0, active: 0, activeBytes: 0 })
})

test("incoming background work cannot evict queued visible-tail work", () => {
  const posted: number[] = []
  const superseded: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({
    lanes: 1,
    maxQueued: 1,
    maxQueuedBytes: 4,
  })
  const send = (value: Request, priority: "background" | "tail") =>
    admission.send(value, {
      lane: 0,
      kind: value.type,
      priority,
      bytes: 4,
      post: (item) => posted.push(item.id),
      supersede: (item) => superseded.push(item.id),
    })

  send(request(1, "active"), "tail")
  expect(send(request(2, "queued-tail"), "tail")).toBe(true)
  expect(send(request(3, "background"), "background")).toBe(false)
  expect(superseded).toEqual([3])
  admission.complete(1)
  expect(posted).toEqual([1, 2])
})

test("tail work has a reserved lane that active background work cannot occupy", () => {
  const posted: number[] = []
  const admission = createMarkdownWorkerAdmission<Request>({ lanes: 2 })
  const laneFor = (value: Request, priority: "background" | "tail") =>
    markdownLaneForPriority(value.key, priority, 2)
  const send = (value: Request, priority: "background" | "tail") =>
    admission.send(value, {
      lane: laneFor(value, priority),
      kind: value.type,
      priority,
      bytes: 1,
      post: (item) => posted.push(item.id),
      supersede: () => {},
    })

  expect(send(request(1, "large-history"), "background")).toBe(true)
  expect(send(request(2, "live-tail"), "tail")).toBe(true)
  expect(laneFor(request(1, "large-history"), "background")).toBe(0)
  expect(laneFor(request(2, "live-tail"), "tail")).toBe(1)
  expect(posted).toEqual([1, 2])
  expect(admission.snapshot()).toEqual({ queued: 0, queuedBytes: 0, active: 2, activeBytes: 2 })
})
