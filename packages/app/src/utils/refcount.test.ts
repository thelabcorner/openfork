import { describe, expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { createRefCountMap } from "./refcount"
import { pathKey } from "./path-key"

describe("createRefCountMap", () => {
  test("removes an item after its last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["/project"])
  })

  test("keeps equivalent path consumers until the last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
      pathKey,
    )
    const first = createRoot((dispose) => {
      map("C:\\repo")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("C:/repo/")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["C:/repo"])
  })

  test("a create() that registers its own onCleanup does not tear down while other consumers still hold the item", () => {
    // Regression test: createDirSdkContext registers `onCleanup(unsub)` inside
    // `create()` to tear down its event-relay subscription. That must be tied to
    // the item's own lifetime (last consumer disposing), not to whichever caller
    // happened to trigger creation -- otherwise the first of several tabs open on
    // the same directory to close silently kills event delivery for the rest.
    const events: string[] = []
    const map = createRefCountMap((key: string) => {
      onCleanup(() => events.push(`unsub:${key}`))
      return { key }
    })

    const disposeA = createRoot((dispose) => {
      map("/project") // first caller -> create() runs here
      return dispose
    })
    const disposeB = createRoot((dispose) => {
      map("/project") // second caller -> cache hit
      return dispose
    })

    disposeA()
    expect(events).not.toContain("unsub:/project")

    disposeB()
    expect(events).toContain("unsub:/project")
  })
})
