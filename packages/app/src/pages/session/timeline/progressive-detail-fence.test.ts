import { expect, test } from "bun:test"
import { createProgressiveDetailFence } from "./progressive-detail-fence"

test("progressive detail ignores pages that finish after close or identity change", async () => {
  const fence = createProgressiveDetailFence()
  let resolve!: (value: string) => void
  const pending = new Promise<string>((done) => (resolve = done))
  const committed: string[] = []

  fence.open("session-a/message-a")
  const ticket = fence.ticket()!
  const request = pending.then((page) => {
    if (fence.current(ticket)) committed.push(page)
  })

  fence.close()
  const reopened = fence.open("session-a/message-a")!
  resolve("closed-page")
  await request
  expect(committed).toEqual([])
  expect(fence.current(reopened)).toBe(true)

  const next = reopened
  fence.changeIdentity("session-b/message-b")
  if (fence.current(next)) committed.push("stale-identity-page")
  expect(committed).toEqual([])

  const current = fence.open("session-b/message-b")!
  if (fence.current(current)) committed.push("current-page")
  expect(committed).toEqual(["current-page"])
})
