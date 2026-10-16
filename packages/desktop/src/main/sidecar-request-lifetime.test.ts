import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import { createSidecarRequestLifetimes } from "./sidecar-request-lifetime"

test.each([1, 3, 6, 14])("%i held control requests share one renderer observer and abort on destruction", (count) => {
  const sender = Object.assign(new EventEmitter(), { id: 1 })
  const lifetimes = createSidecarRequestLifetimes()
  const controllers = Array.from({ length: count }, () => new AbortController())
  const releases = controllers.map(controller => lifetimes.retain(sender, controller))
  expect(sender.listenerCount("destroyed")).toBe(1)
  sender.emit("destroyed")
  expect(controllers.every(controller => controller.signal.aborted)).toBe(true)
  releases.forEach(release => release())
  expect(sender.listenerCount("destroyed")).toBe(0)
})

test("completion and shutdown release observers without cancelling another renderer", () => {
  const lifetimes = createSidecarRequestLifetimes()
  const first = Object.assign(new EventEmitter(), { id: 1 })
  const second = Object.assign(new EventEmitter(), { id: 2 })
  const finished = new AbortController()
  const pending = new AbortController()
  const release = lifetimes.retain(first, finished)
  const releasePending = lifetimes.retain(second, pending)
  pending.signal.addEventListener("abort", releasePending, { once: true })
  release()
  release()
  expect(first.listenerCount("destroyed")).toBe(0)
  expect(second.listenerCount("destroyed")).toBe(1)
  lifetimes.clear()
  expect(finished.signal.aborted).toBe(false)
  expect(pending.signal.aborted).toBe(true)
  expect(second.listenerCount("destroyed")).toBe(0)
})
