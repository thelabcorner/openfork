import { expect, test } from "bun:test"
import { createRequestGate } from "./request-gate"

test("request gate keeps 100 rapid requests bounded", async () => {
  const gate = createRequestGate(4)
  let active = 0
  let maxActive = 0
  const tasks = Array.from({ length: 100 }, (_, index) =>
    gate(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return index
    }),
  )
  const results = await Promise.all(tasks)
  expect(maxActive).toBe(4)
  expect(results).toHaveLength(100)
})
