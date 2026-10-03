import { describe, expect, test } from "bun:test"
import { reuseStableEntries } from "./limits-panel-entry-identity"

describe("limits entry identity", () => {
  test("reuses card entries for equal quota snapshots and replaces changed provider data", () => {
    const provider = { id: "acme", result: {} }
    const previous = [{ key: "p:acme", provider }]
    expect(reuseStableEntries(previous, [{ key: "p:acme", provider }], (a, b) => a.key === b.key && a.provider === b.provider)).toBe(previous)
    expect(reuseStableEntries(previous, [{ key: "p:acme", provider: { id: "acme", result: {} } }], (a, b) => a.key === b.key && a.provider === b.provider)).not.toBe(previous)
  })
})
