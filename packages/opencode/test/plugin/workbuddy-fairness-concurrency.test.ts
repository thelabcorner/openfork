import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { AdmissionError, WorkBuddyEntitlementGovernor, launchPumpDelayMs } from "@/plugin/workbuddy-governor"

test("launch timer waits for only the outstanding token deficit", () => {
  expect(launchPumpDelayMs(0, 2)).toBe(500)
  expect(launchPumpDelayMs(0.9, 2)).toBe(50)
  expect(launchPumpDelayMs(0.99, 4)).toBe(20)
  expect(launchPumpDelayMs(Number.NaN, 2)).toBe(500)
  expect(launchPumpDelayMs(0, 0)).toBe(2000)
})

test("account-local fair scheduling bounds historical Session virtual-clock retention", async () => {
  // No real provider requests or credentials. High launch capacity isolates the
  // virtual-time data structure from the independent rate limiter.
  const governor = new WorkBuddyEntitlementGovernor({
    persistenceFile: join(tmpdir(), `workbuddy-virtual-time-${randomUUID()}.json`),
    maxConcurrent: 4,
    launchBurst: 512,
    launchPerSec: 10000,
  })
  const started = performance.now()
  for (let index = 0; index < 320; index++) {
    const session = index === 0 ? "__proto__" : `ses_historical_${index}`
    const result = await governor.runGeneration({
      session,
      genKey: `generation_${index}`,
      model: "unmetered-test",
      priority: index % 2 === 0 ? 0 : 4,
      isExpired: () => false,
      refresh: async () => ({ ok: true }),
      transport: async () => new Response(null, { status: 204 }),
    })
    expect(result.committed).toBe(true)
    result.lease.release()
  }
  expect(governor.metrics()).toMatchObject({ active: 0, queued: 0, generations: 320 })
  expect(governor.metrics().fairnessSessions).toBeLessThanOrEqual(256)
  expect(performance.now() - started).toBeLessThan(10_000)
}, 15_000)

test("100 competing requests respect four live streams and fail excess admission without queue growth", async () => {
  const governor = new WorkBuddyEntitlementGovernor({
    persistenceFile: join(tmpdir(), `workbuddy-saturation-${randomUUID()}.json`),
    maxConcurrent: 4,
    launchBurst: 200,
    launchPerSec: 10000,
  })
  let inTransport = 0
  let maximumTransport = 0
  let physicalAttempts = 0
  const jobs = Array.from({ length: 100 }, (_, index) => governor.runGeneration({
    session: `ses_stress_${index}`,
    genKey: `generation_stress_${index}`,
    model: "unmetered-test",
    priority: index % 3 === 0 ? 0 : 4,
    isExpired: () => false,
    refresh: async () => ({ ok: true as const }),
    transport: async () => {
      inTransport++
      physicalAttempts++
      maximumTransport = Math.max(maximumTransport, inTransport)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inTransport--
      return new Response(null, { status: 204 })
    },
  }))
  expect(governor.metrics().active).toBeLessThanOrEqual(4)
  expect(governor.metrics().active + governor.metrics().queued).toBeLessThanOrEqual(24)
  const results = await Promise.allSettled(jobs)
  const accepted = results.filter((item) => item.status === "fulfilled")
  const rejected = results.filter((item) => item.status === "rejected")
  expect(accepted).toHaveLength(24)
  expect(rejected).toHaveLength(76)
  expect(rejected.every((item) => item.status === "rejected" &&
    item.reason instanceof AdmissionError && item.reason.kind === "queue")).toBe(true)
  expect(maximumTransport).toBeLessThanOrEqual(4)
  expect(physicalAttempts).toBe(24)
  expect(governor.metrics()).toMatchObject({ active: 0, queued: 0, generations: 24, attempts: 24 })
}, 15_000)