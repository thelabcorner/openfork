import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createMenuDismissController } from "./menu-dismiss-controller"

describe("createMenuDismissController", () => {
  const original = globalThis.requestAnimationFrame
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = original
  })

  const runFrame = () => frames.shift()?.(0)

  test("runs an action after disconnected content settles", () => {
    let called = 0
    const dismiss = createMenuDismissController(() => ({ isConnected: false }) as HTMLElement)
    dismiss.afterClose(() => called++)

    runFrame()
    runFrame()
    runFrame()

    expect(called).toBe(1)
  })

  test("cancels stale work when a close generation is no longer valid", () => {
    let valid = true
    let called = 0
    const dismiss = createMenuDismissController(() => ({ isConnected: true }) as HTMLElement)
    dismiss.afterClose(() => called++, () => valid)

    runFrame()
    valid = false
    runFrame()

    expect(called).toBe(0)
    expect(frames).toHaveLength(0)
  })
})
