import { describe, expect, test } from "bun:test"
import type { SidecarOxpState } from "./sidecar-protocol"
import { dispatchOxpState } from "./oxp-state-dispatch"

const state = { version: 1 } as SidecarOxpState

describe("OXP sidecar state delivery", () => {
  test("requires an explicit owner acceptance before a runtime trial can be acknowledged", () => {
    expect(dispatchOxpState(state, [])).toBe(false)
    expect(dispatchOxpState(state, [() => undefined, () => false])).toBe(false)
    expect(dispatchOxpState(state, [() => true])).toBe(true)
  })

  test("continues delivery after a rejecting or throwing observer", () => {
    let delivered = false
    const accepted = dispatchOxpState(state, [
      () => {
        throw new Error("observer failed")
      },
      () => false,
      () => {
        delivered = true
        return true
      },
    ])

    expect(delivered).toBe(true)
    expect(accepted).toBe(true)
  })
})
