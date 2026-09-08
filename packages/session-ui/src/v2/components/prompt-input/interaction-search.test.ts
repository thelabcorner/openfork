import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDeferredContextSearch } from "./interaction"

describe("deferred prompt context search", () => {
  test("superseded debounce promises always settle", async () => {
    let dispose = () => {}
    let calls = 0
    const search = createRoot((rootDispose) => {
      dispose = rootDispose
      return createDeferredContextSearch(async () => {
        calls++
        return []
      })
    })

    try {
      const first = search.run("s")
      const second = search.run("se")
      const firstResult = await Promise.race([
        first,
        Bun.sleep(150).then(() => "timeout" as const),
      ])
      expect(firstResult).toEqual([])
      expect(await second).toEqual([])
      expect(calls).toBe(1)
    } finally {
      dispose()
    }
  })
})
