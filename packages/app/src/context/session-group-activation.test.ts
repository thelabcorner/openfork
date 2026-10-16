import { expect, test } from "bun:test"
import { createSessionGroupActivation } from "./session-group-activation"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("rapid consumers share one delayed activation, which cannot fire twice", async () => {
  let called = 0
  const controller = createSessionGroupActivation(() => called++, 1)
  for (let i = 0; i < 500; i++) controller.request()
  await sleep(10)
  expect(called).toBe(1)
  controller.request()
  await sleep(5)
  expect(called).toBe(1)
  controller.dispose()
})

test("owner disposal cancels group activation and all later requests", async () => {
  let called = 0
  const controller = createSessionGroupActivation(() => called++, 10)
  controller.request()
  controller.dispose()
  controller.request()
  await sleep(20)
  expect(called).toBe(0)
})

test("committed hover skips the second bootstrap delay without double activation", async () => {
  let called = 0
  const controller = createSessionGroupActivation(() => called++, 30)
  controller.request()
  controller.now()
  expect(called).toBe(1)
  await sleep(40)
  expect(called).toBe(1)
  controller.now()
  controller.dispose()
  expect(called).toBe(1)
})