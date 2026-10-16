import { describe, expect, test } from "bun:test"
import { stopLeftObservedGenerationOwned } from "./session-stop-confirmation"

describe("current Session Stop acknowledgement", () => {
  test("rejects a NoContent success when the exact observed owner still holds the generation", () => {
    expect(stopLeftObservedGenerationOwned(
      { ownerID: "runtime-A", generation: 12 },
      { ownerID: "runtime-A", generation: 12 },
    )).toBe(true)
  })

  test("accepts an idle generation that was already stopped", () => {
    expect(stopLeftObservedGenerationOwned(
      { ownerID: "runtime-A", generation: 12 },
      { ownerID: null, generation: 12 },
    )).toBe(false)
  })

  test("never conflates a new generation with an already-cancelled one", () => {
    expect(stopLeftObservedGenerationOwned(
      { ownerID: "runtime-A", generation: 12 },
      { ownerID: "runtime-A", generation: 13 },
    )).toBe(false)
    expect(stopLeftObservedGenerationOwned(
      { ownerID: null, generation: 12 },
      { ownerID: "runtime-B", generation: 13 },
    )).toBe(false)
  })
})
