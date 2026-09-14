import { expect, test } from "bun:test"
import { createRequestGate } from "./request-gate"
import { GROUP_PREVIEW_PAGE, TAB_PREVIEW_RESOLVE_CONCURRENCY } from "../components/titlebar-tab-popover"

test("tab-preview global lane keeps 100 rapid hydration requests bounded", async () => {
  const gate = createRequestGate(TAB_PREVIEW_RESOLVE_CONCURRENCY)
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
  expect(GROUP_PREVIEW_PAGE).toBe(80)
})
