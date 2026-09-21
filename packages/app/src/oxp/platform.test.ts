import { describe, expect, test } from "bun:test"
import { isOxpPlatform } from "./platform"

const completeBridge = (overrides: Record<string, unknown> = {}) =>
  new Proxy(overrides, {
    get(target, key) {
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key)) return target[key]
      return () => Promise.resolve(undefined)
    },
  })

describe("isOxpPlatform", () => {
  test("accepts a bridge that implements the complete required contract", () => {
    expect(isOxpPlatform(completeBridge())).toBe(true)
  })

  test("rejects the stale preload shape that predates project-root synchronization", () => {
    expect(
      isOxpPlatform(
        completeBridge({
          syncProjectRoots: undefined,
        }),
      ),
    ).toBe(false)
  })

  test("rejects an older partial OXP bridge even when bootstrap methods exist", () => {
    expect(
      isOxpPlatform({
        getState: () => Promise.resolve(undefined),
        subscribe: () => () => {},
      }),
    ).toBe(false)
  })
})
