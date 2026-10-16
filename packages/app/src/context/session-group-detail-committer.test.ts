import { expect, test } from "bun:test"
import { createSessionGroupDetailCommitter } from "./session-group-detail-committer"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("a thousand legacy group completions publish bounded progressive store batches", () => {
  const published: number[][] = []
  const batch = createSessionGroupDetailCommitter<number>({
    valid: () => true,
    publish: (rows) => published.push([...rows]),
    maxBatch: 32,
    delayMs: 1_000,
  })
  for (let i = 0; i < 1_000; i++) batch.add(i)
  batch.finish()
  expect(published).toHaveLength(Math.ceil(1000 / 32))
  expect(published.every((rows) => rows.length <= 32)).toBe(true)
  expect(published.flat()).toEqual(Array.from({ length: 1000 }, (_, i) => i))
  batch.finish()
  batch.add(1_001)
  expect(published.flat()).toHaveLength(1_000)
})

test("slow legacy fallback shows first partial group roster after bounded delay", async () => {
  const updates: string[][] = []
  const batch = createSessionGroupDetailCommitter<string>({
    valid: () => true,
    publish: (rows) => updates.push([...rows]),
    maxBatch: 32,
    delayMs: 5,
  })
  batch.add("available")
  await sleep(15)
  expect(updates).toEqual([["available"]])
  batch.add("late")
  batch.finish()
  expect(updates).toEqual([["available"], ["late"]])
})

test("superseded generation or teardown cannot publish stale queued details", async () => {
  let valid = true
  const updates: number[][] = []
  const batch = createSessionGroupDetailCommitter<number>({
    valid: () => valid,
    publish: (rows) => updates.push([...rows]),
    delayMs: 5,
  })
  batch.add(1)
  valid = false
  await sleep(15)
  expect(updates).toEqual([])
  batch.finish()
  const cancelled = createSessionGroupDetailCommitter<number>({
    valid: () => true,
    publish: (rows) => updates.push([...rows]),
    delayMs: 5,
  })
  cancelled.add(2)
  cancelled.cancel()
  await sleep(15)
  expect(updates).toEqual([])
})