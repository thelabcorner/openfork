import { describe, expect, test } from "bun:test"
import { createSessionVcsRefreshController } from "./session-vcs-refresh"

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe("session VCS refresh controller", () => {
  test("hidden invalidations perform zero git work and visibility consumes one dirty latch", async () => {
    let visible = false
    let calls = 0
    const controller = createSessionVcsRefreshController({
      visible: () => visible,
      identity: () => "repo:main",
      request: async () => void calls++,
      delayMs: 0,
    })
    controller.invalidate()
    controller.invalidate()
    await tick()
    expect(calls).toBe(0)
    visible = true
    controller.visibleChanged()
    await tick()
    expect(calls).toBe(1)
    controller.dispose()
  })

  test("an invalidation racing a successful request schedules at most one follow-up", async () => {
    let resolve!: () => void
    let calls = 0
    const controller = createSessionVcsRefreshController({
      visible: () => true,
      identity: () => "repo:main",
      request: () => {
        calls++
        return new Promise<void>((done) => (resolve = done))
      },
      delayMs: 0,
    })
    controller.visibleChanged()
    await tick()
    controller.invalidate()
    controller.invalidate()
    expect(calls).toBe(1)
    resolve()
    await tick()
    expect(calls).toBe(2)
    controller.dispose()
  })

  test("persistent failure does not create an automatic retry loop", async () => {
    let calls = 0
    const controller = createSessionVcsRefreshController({
      visible: () => true,
      identity: () => "repo:main",
      request: async () => {
        calls++
        throw new Error("git failed")
      },
      delayMs: 0,
    })
    controller.visibleChanged()
    await tick(20)
    expect(calls).toBe(1)
    expect(controller.state().retryBlocked).toBe(true)
    controller.invalidate()
    await tick()
    expect(calls).toBe(2)
    controller.dispose()
  })
})
