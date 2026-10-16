import { expect, test } from "bun:test"
import { staleTabVisibilityKeys } from "./titlebar-tab-order"

test("tab churn prunes historical visibility without affecting live, hidden or duplicated keys", () => {
  expect(
    staleTabVisibilityKeys({ current: true, hidden: false, closed: true, older: false }, [
      "current",
      "hidden",
      "current",
    ]),
  ).toEqual(["closed", "older"])
  expect(staleTabVisibilityKeys({}, ["new"])).toEqual([])
})