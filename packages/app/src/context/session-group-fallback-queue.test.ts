import { expect, test } from "bun:test"
import { fetchSessionGroupDetailsBounded } from "./session-group-fallback-queue"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("legacy detail fallback admits no more than four simultaneous group requests", async () => {
  const ids = Array.from({ length: 64 }, (_, i) => `group-${i}`)
  const seen: string[] = []
  let running = 0
  let peak = 0
  await fetchSessionGroupDetailsBounded(ids, async (id) => {
    running++
    peak = Math.max(peak, running)
    await sleep(1)
    seen.push(id)
    running--
  }, () => true)
  expect(peak).toBe(4)
  expect(running).toBe(0)
  expect(new Set(seen)).toEqual(new Set(ids))
})

test("a newer detail generation stops admitting stale queued requests", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => `group-${i}`)
  let admitted = 0
  let valid = true
  await fetchSessionGroupDetailsBounded(ids, async () => {
    admitted++
    if (admitted === 6) valid = false
    await Promise.resolve()
  }, () => valid)
  expect(admitted).toBeGreaterThanOrEqual(6)
  expect(admitted).toBeLessThanOrEqual(9)
})

test("individual errors are isolated and empty or invalid batches dispatch nothing", async () => {
  const visited: string[] = []
  const fetch = async (id: string) => {
    visited.push(id)
    if (id === "bad") throw Error("not supported")
  }
  await fetchSessionGroupDetailsBounded(["a", "bad", "b"], fetch, () => true, 2)
  expect(new Set(visited)).toEqual(new Set(["a", "bad", "b"]))
  await fetchSessionGroupDetailsBounded(["skip"], fetch, () => false)
  await fetchSessionGroupDetailsBounded([], fetch, () => true)
  expect(visited.includes("skip")).toBe(false)
})