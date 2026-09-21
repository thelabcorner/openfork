import { describe, expect, test } from "bun:test"
import { createDraftStore } from "./draft-store"

function harness(options?: { failSet?: boolean }) {
  const values = new Map<string, string>()
  let sets = 0
  const store = createDraftStore({
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      sets += 1
      if (options?.failSet) throw new Error("synthetic durable write failure")
      values.set(key, value)
    },
    remove: async (key) => {
      values.delete(key)
    },
    putBlob: async () => "blob",
    getBlob: async () => null,
  })
  return { store, values, sets: () => sets }
}

describe("draft store flush barrier", () => {
  test("forces the latest coalesced write to durable storage immediately", async () => {
    const { store, values, sets } = harness()
    await store.setItem("prompt", JSON.stringify({ value: "first" }))
    await store.setItem("prompt", JSON.stringify({ value: "revision" }))

    expect(sets()).toBe(0)
    await store.flush()

    expect(sets()).toBe(1)
    expect(JSON.parse(values.get("prompt")!)).toEqual({ value: "revision" })
  })

  test("propagates durable write failure to explicit callers", async () => {
    const { store } = harness({ failSet: true })
    await store.setItem("prompt", JSON.stringify({ value: "revision" }))

    await expect(store.flush()).rejects.toThrow("synthetic durable write failure")
  })
})
