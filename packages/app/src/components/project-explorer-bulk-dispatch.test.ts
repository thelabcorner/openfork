import { describe, expect, test } from "bun:test"
import { dispatchProjectExplorerBulk } from "./project-explorer-bulk-dispatch"

describe("Project Explorer bounded bulk operations", () => {
  test("never admits more than one unfinished chunk while processing >512 files", async () => {
    let active = 0
    let peak = 0
    let completed = 0
    const operations = Array.from({ length: 1_025 }, (_, i) => i)
    const result = await dispatchProjectExplorerBulk(operations, async () => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      completed++
      return true
    }, { cancelled: () => false, chunkSize: 32, yield: async () => {} })
    expect(result).toBe(operations.length)
    expect(completed).toBe(operations.length)
    expect(peak).toBeLessThanOrEqual(32)
  })

  test("applies backpressure to an unresolved async backend", async () => {
    let unblock!: () => void
    const barrier = new Promise<void>((resolve) => { unblock = resolve })
    let attempted = 0
    const pending = dispatchProjectExplorerBulk(
      Array.from({ length: 100 }, (_, i) => i),
      async () => { attempted++; await barrier; return true },
      { cancelled: () => false, chunkSize: 8, yield: async () => {} },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(attempted).toBe(8)
    unblock()
    expect(await pending).toBe(100)
    expect(attempted).toBe(100)
  })

  test("stops the producer on explicit admission failure or cancellation", async () => {
    let attempts = 0
    const halted = await dispatchProjectExplorerBulk(
      Array.from({ length: 100 }, (_, i) => i),
      async (i) => { attempts++; return i !== 2 },
      { cancelled: () => false, chunkSize: 8, yield: async () => {} },
    )
    expect(halted).toBe(8)
    expect(attempts).toBe(8)

    let stopped = false
    const onlyFirst = await dispatchProjectExplorerBulk(
      Array.from({ length: 100 }, (_, i) => i),
      async () => true,
      { cancelled: () => stopped, chunkSize: 8, yield: async () => { stopped = true } },
    )
    expect(onlyFirst).toBe(8)
  })
})
