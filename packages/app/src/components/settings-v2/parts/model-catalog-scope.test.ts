import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createModelPickerOpenGate } from "./model-catalog-scope"

describe("createModelPickerOpenGate", () => {
  test("stays active until the final open picker closes", () => {
    createRoot((dispose) => {
      const gate = createModelPickerOpenGate()
      const first = {}
      const second = {}

      expect(gate.active()).toBe(false)
      gate.set(first, true)
      expect(gate.active()).toBe(true)

      gate.set(first, true)
      gate.set(second, true)
      gate.set(first, false)
      expect(gate.active()).toBe(true)

      gate.set(second, false)
      expect(gate.active()).toBe(false)
      dispose()
    })
  })
})
