import { expect, test } from "bun:test"
import { isReadOnlyChild, showsSessionComposer } from "./human-interjection"

test("delegated root and nested composers remain available alongside permission blockers", () => {
  for (const parentID of [undefined, "ses_parent"]) {
    for (const permissionPending of [false, true]) {
      const worker = { parentID, humanInterjection: true }
      expect(isReadOnlyChild(worker)).toBe(false)
      expect(showsSessionComposer(worker, permissionPending)).toBe(true)
    }
  }
  expect(isReadOnlyChild({ parentID: "ses_opaque" })).toBe(true)
  expect(isReadOnlyChild({ parentID: "ses_opaque", humanInterjection: false })).toBe(true)
  expect(showsSessionComposer({}, true)).toBe(false)
})
