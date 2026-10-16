import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInputV2PersistedState } from "./types"

let createPromptInputV2Controller: typeof import("./interaction").createPromptInputV2Controller

beforeAll(async () => {
  mock.module("@opencode-ai/ui/hooks", () => ({
    useFilteredList: (input: { items: () => unknown[] }) => ({
      flat: () => input.items(),
      onInput() {},
    }),
  }))
  createPromptInputV2Controller = (await import("./interaction")).createPromptInputV2Controller
})

describe("prompt input v2 command demand", () => {
  test("notifies once when slash intent opens the command picker", async () => {
    const [store, setStore] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })
    let commandOpens = 0

    const dispose = createRoot((dispose) => {
      const controller = createPromptInputV2Controller({
        store: [() => store, setStore],
        commands: () => [],
        context: () => [],
        searchContextFiles: () => [],
        onCommandOpen: () => commandOpens++,
        view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
      })
      controller.dispatch({ type: "input.changed", value: "/re" })
      controller.dispatch({ type: "input.changed", value: "/rev" })
      controller.dispatch({ type: "input.changed", value: "ordinary prompt" })
      return dispose
    })

    await Promise.resolve()
    dispose()
    expect(commandOpens).toBe(1)
  })

  test("keeps the stop hotkey available for an interrupted non-generating session", () => {
    const [store, setStore] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "keep this draft", start: 0, end: 15 }],
      cursor: 15,
      context: { items: [] },
    })
    let stops = 0

    const dispose = createRoot((dispose) => {
      const controller = createPromptInputV2Controller({
        store: [() => store, setStore],
        commands: () => [],
        context: () => [],
        searchContextFiles: () => [],
        view: {
          submit: {
            stopping: () => true,
            working: () => false,
            onSubmit() {},
            onStop() {
              stops++
            },
          },
        },
      })
      let prevented = false
      controller.onKeyDown({
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        preventDefault() {
          prevented = true
        },
      } as unknown as KeyboardEvent)
      expect(prevented).toBe(true)
      expect(stops).toBe(1)
      expect(store.prompt).toEqual([{ type: "text", content: "keep this draft", start: 0, end: 15 }])
      return dispose
    })
    dispose()
  })
})
