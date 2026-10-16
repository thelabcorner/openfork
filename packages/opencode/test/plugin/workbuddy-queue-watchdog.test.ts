import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { WorkBuddyEntitlementGovernor } from "@/plugin/workbuddy-governor"

test("a stalled active stream cannot leave queued generations suspended indefinitely", async () => {
  const governor = new WorkBuddyEntitlementGovernor({
    persistenceFile: join(tmpdir(), `workbuddy-queue-watchdog-${randomUUID()}.json`),
    maxConcurrent: 1, launchBurst: 8, launchPerSec: 1000, maxQueueWaitMs: 45,
  })
  let transports = 0
  const opts = (key: string, signal?: AbortSignal) => ({
    session: `ses_${key}`, genKey: key, model: "unmetered-test", priority: 0,
    isExpired: () => false, refresh: async () => ({ ok: true as const }),
    transport: async () => {
      transports++
      return new Response(new ReadableStream(), { status: 200 })
    },
    signal,
  })
  const held = await governor.runGeneration(opts("held"))
  expect(governor.metrics()).toMatchObject({ active: 1, queued: 0, queueTimeouts: 0 })
  try {
    const delayed = governor.runGeneration(opts("timed-out"))
    await Promise.resolve()
    expect(governor.metrics()).toMatchObject({ active: 1, queued: 1 })
    expect(governor.metrics().oldestQueuedMs).toBeGreaterThanOrEqual(0)
    await expect(delayed).rejects.toMatchObject({ status: 503, kind: "queue" })
    expect(governor.metrics()).toMatchObject({
      active: 1, queued: 0, generations: 1, attempts: 1, queueTimeouts: 1,
    })
    expect(transports).toBe(1)

    const cancelled = new AbortController()
    const before = governor.runGeneration(opts("cancelled", cancelled.signal))
    cancelled.abort()
    await expect(before).rejects.toMatchObject({ status: 499, kind: "cancel" })
    expect(governor.metrics()).toMatchObject({ active: 1, queued: 0, queueTimeouts: 1 })
  } finally {
    held.lease.release()
    await held.res.body?.cancel()
  }
  const restored = await governor.runGeneration({
    // Explicit retry of the very same logical request after its failed
    // admission must not trip the duplicate-generation guard.
    ...opts("timed-out"), transport: async () => {
      transports++
      return new Response(null, { status: 204 })
    },
  })
  expect(restored.committed).toBe(true)
  restored.lease.release()
  expect(transports).toBe(2)
  expect(governor.metrics()).toMatchObject({ active: 0, queued: 0, queueTimeouts: 1 })
}, 15_000)

test("an admitted waiter clears its queue deadline when an earlier lease releases", async () => {
  const governor = new WorkBuddyEntitlementGovernor({
    persistenceFile: join(tmpdir(), `workbuddy-admit-watchdog-${randomUUID()}.json`),
    maxConcurrent: 1, launchBurst: 8, launchPerSec: 1000, maxQueueWaitMs: 45,
  })
  const options = (key: string) => ({
    session: key, genKey: key, model: "unmetered-test", priority: 0,
    isExpired: () => false, refresh: async () => ({ ok: true as const }),
    transport: async () => new Response(new ReadableStream(), { status: 200 }),
  })
  const first = await governor.runGeneration(options("first"))
  const secondPromise = governor.runGeneration(options("second"))
  first.lease.release()
  await first.res.body?.cancel()
  const second = await secondPromise
  expect(second.committed).toBe(true)
  expect(governor.metrics()).toMatchObject({ active: 1, queued: 0 })
  await new Promise((resolve) => setTimeout(resolve, 65))
  expect(governor.metrics()).toMatchObject({ active: 1, queued: 0, queueTimeouts: 0 })
  second.lease.release()
  await second.res.body?.cancel()
  expect(governor.metrics()).toMatchObject({ active: 0, queued: 0 })
}, 15_000)