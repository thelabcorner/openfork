import { expect, test } from "bun:test"
import { waitForServerHealth } from "./server-health"

test("exit cancels an in-flight health request", async () => {
  const exit = Promise.withResolvers<number>()
  const entered = Promise.withResolvers<AbortSignal>()
  let calls = 0
  const waiting = waitForServerHealth(async (signal) => {
    calls++
    entered.resolve(signal)
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return false
  }, exit.promise)
  const signal = await entered.promise
  exit.resolve(9)
  await expect(waiting).rejects.toThrow("code 9")
  expect(signal.aborted).toBe(true)
  expect(calls).toBe(1)
})

test("exit before the retry timer runs never sends a health request", async () => {
  let calls = 0
  await expect(
    waitForServerHealth(async () => {
      calls++
      return false
    }, Promise.resolve(1)),
  ).rejects.toThrow("code 1")
  expect(calls).toBe(0)
})

test("success completes health initialization and tolerates a later process exit", async () => {
  const exit = Promise.withResolvers<number>()
  let signal: AbortSignal | undefined
  await waitForServerHealth(async (value) => {
    signal = value
    return true
  }, exit.promise)
  expect(signal?.aborted).toBe(true)
  exit.resolve(0)
  await exit.promise
})
