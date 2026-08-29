import { describe, expect, test } from "bun:test"
import {
  AUTO_SCROLL_ESCAPE_PX,
  AUTO_SCROLL_STICK_PX,
  classifyAutoScroll,
  isProgrammaticScroll,
} from "./auto-scroll-intent"

const thresholds = {
  stickThreshold: AUTO_SCROLL_STICK_PX,
  escapeThreshold: AUTO_SCROLL_ESCAPE_PX,
}

describe("isProgrammaticScroll", () => {
  test("matches a one-shot stick-to-bottom write", () => {
    expect(isProgrammaticScroll({ pendingTop: 800, scrollTop: 800, delta: 0 })).toBe(true)
    expect(isProgrammaticScroll({ pendingTop: 800, scrollTop: 801, delta: 1 })).toBe(true)
  })
  test("does not swallow an upward user fling even when still near the pending top", () => {
    expect(isProgrammaticScroll({ pendingTop: 800, scrollTop: 798, delta: -5 })).toBe(false)
    expect(isProgrammaticScroll({ pendingTop: 800, scrollTop: 799, delta: -1.2 })).toBe(false)
  })
  test("is inactive without a pending write", () => {
    expect(isProgrammaticScroll({ pendingTop: null, scrollTop: 800, delta: 0 })).toBe(false)
  })
})

describe("classifyAutoScroll", () => {
  test("treats programmatic frames as prog unless the user is moving up decisively", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 0, delta: 0, isProgrammatic: true })).toBe("prog")
    expect(classifyAutoScroll({ ...thresholds, distance: 4, delta: -2, isProgrammatic: true })).toBe("escape")
  })
  test("does not escape on micro-jitter at the bottom", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 2, delta: -0.6, isProgrammatic: false })).toBe("stick")
    expect(classifyAutoScroll({ ...thresholds, distance: 2, delta: -1, isProgrammatic: false })).toBe("stick")
  })
  test("escapes on a decisive flick even while still inside the stick zone", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 3, delta: -2, isProgrammatic: false })).toBe("escape")
  })
  test("escapes on modest uptick once beyond stick band (middle-click autoscroll)", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 12, delta: -1, isProgrammatic: false })).toBe("escape")
  })
  test("re-anchors only when at the bottom and not moving up", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 2, delta: 0, isProgrammatic: false })).toBe("stick")
    expect(classifyAutoScroll({ ...thresholds, distance: 4, delta: 12, isProgrammatic: false })).toBe("stick")
  })
  test("escapes once distance clears the hysteresis band", () => {
    expect(
      classifyAutoScroll({ ...thresholds, distance: AUTO_SCROLL_ESCAPE_PX + 1, delta: 0, isProgrammatic: false }),
    ).toBe("escape")
  })
  test("does not treat a teleport onto the bottom as a user return", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 0, delta: 200, isProgrammatic: false })).toBe("hold")
  })
  test("holds between stick and escape while drifting down", () => {
    expect(classifyAutoScroll({ ...thresholds, distance: 16, delta: 4, isProgrammatic: false })).toBe("hold")
  })
})
