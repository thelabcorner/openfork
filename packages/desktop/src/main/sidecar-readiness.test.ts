import { describe, expect, test } from "bun:test"
import { createSidecarReadiness } from "./sidecar-readiness"

describe("sidecar readiness lease", () => {
  test("invalidates the published endpoint when its owning process exits", () => {
    const readiness = createSidecarReadiness<{ url: string }>()
    const owner = readiness.begin()
    const endpoint = { url: "http://127.0.0.1:4096" }

    expect(readiness.publish(owner, endpoint)).toBe(true)
    expect(readiness.get()).toBe(endpoint)
    expect(readiness.invalidate(owner)).toBe(true)
    expect(readiness.get()).toBeNull()
    expect(readiness.publish(owner, endpoint)).toBe(false)
  })

  test("a delayed exit from an older process cannot invalidate the current endpoint", () => {
    const readiness = createSidecarReadiness<{ url: string }>()
    const oldOwner = readiness.begin()
    const nextOwner = readiness.begin()
    const endpoint = { url: "http://127.0.0.1:4097" }

    expect(readiness.publish(nextOwner, endpoint)).toBe(true)
    expect(readiness.invalidate(oldOwner)).toBe(false)
    expect(readiness.get()).toBe(endpoint)
  })
})
