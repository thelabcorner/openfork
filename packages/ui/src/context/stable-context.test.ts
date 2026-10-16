import { describe, expect, test } from "bun:test"
import { createComponent, createContext, useContext } from "solid-js"
import { render } from "solid-js/web"
import { createStableContext } from "./stable-context"

describe("HMR-safe context token identity", () => {
  test("consumer updated after mounting sees the original provider value", () => {
    const original = createStableContext<{ id: string; opened(): boolean }>("@opencode-ai/ui/test/layout")
    const refreshed = createStableContext<{ id: string; opened(): boolean }>("@opencode-ai/ui/test/layout")
    expect(refreshed).toBe(original)

    const Consumer = () => {
      const layout = useContext(refreshed)
      return layout?.id + ":" + layout?.opened()
    }
    const host = document.createElement("div")
    const dispose = render(
      () => createComponent(original.Provider, {
        value: { id: "original", opened: () => true },
        get children() { return createComponent(Consumer, {}) },
      }),
      host,
    )
    try {
      expect(host.textContent).toBe("original:true")
    } finally {
      dispose()
    }
  })

  test("independent keys and unkeyed contexts never alias", () => {
    const a = createStableContext("@opencode-ai/ui/test/one")
    const b = createStableContext("@opencode-ai/ui/test/two")
    expect(a).not.toBe(b)
    expect(createStableContext()).not.toBe(createStableContext())
    expect(createContext()).not.toBe(createContext())
  })
})
