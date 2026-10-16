import { expect, test } from "bun:test"
import { indexSessionGroupsByID } from "./session-group-index"

test("group tab navigation indexes IDs with original first-match precedence", () => {
  const groups = [{ id: "g1", name: "first" }, { id: "g2", name: "other" }, { id: "g1", name: "duplicate" }]
  const index = indexSessionGroupsByID(groups)
  for (const id of ["g1", "g2", "missing"]) {
    expect(index.get(id)).toBe(groups.find((item) => item.id === id))
  }
  expect(indexSessionGroupsByID([]).size).toBe(0)
})