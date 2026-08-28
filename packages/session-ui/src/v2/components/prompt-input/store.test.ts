import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { PromptInputV2PersistedState } from "./types"
import { createPromptInputV2Store } from "./store"

function createPromptStore() {
  return createPromptInputV2Store(
    createStore<PromptInputV2PersistedState>({
      prompt: [
        { type: "text", content: "old", start: 0, end: 3 },
        {
          type: "image",
          id: "attachment-1",
          filename: "notes.txt",
          mime: "text/plain",
          blob: { id: "a", url: "blob:a" },
        },
      ],
      cursor: 3,
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: null },
      context: { items: [] },
    }),
  )
}

describe("prompt input v2 store", () => {
  test("accepts an accessor for the backing store", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([() => state, setState])

    prompt.setText("accessed")

    expect(prompt.state.prompt).toEqual([{ type: "text", content: "accessed", start: 0, end: 8 }])
    expect(prompt.state.cursor).toBe(8)
  })

  test("updates prompt text and cursor together while preserving attachments", () => {
    const prompt = createPromptStore()

    prompt.setText("updated")

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "updated", start: 0, end: 7 },
      {
        type: "image",
        id: "attachment-1",
        filename: "notes.txt",
        mime: "text/plain",
        blob: { id: "a", url: "blob:a" },
      },
    ])
    expect(prompt.state.cursor).toBe(7)
  })

  test("inserts text without flattening structured mentions", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [
        { type: "text", content: "A ", start: 0, end: 2 },
        { type: "file", path: "one", content: "@one", start: 2, end: 6 },
        { type: "text", content: " B", start: 6, end: 8 },
      ],
      cursor: 2,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([state, setState])

    prompt.addText("X\nY")

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "A X\nY", start: 0, end: 5 },
      { type: "file", path: "one", content: "@one", start: 5, end: 9 },
      { type: "text", content: " B", start: 9, end: 11 },
    ])
    expect(prompt.state.cursor).toBe(5)
  })

  test("replaces the active @query with a mention and places the cursor after it", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "see @idx", start: 0, end: 8 }],
      cursor: 8,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([state, setState])

    prompt.addMention({ type: "file", path: "src/index.ts", content: "@src/index.ts", start: 0, end: 0 })

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "file", path: "src/index.ts", content: "@src/index.ts", start: 4, end: 17 },
      { type: "text", content: " ", start: 17, end: 18 },
    ])
    expect(prompt.state.cursor).toBe(18)
  })

  test("inserts a dragged mention at the cursor without eating a prior @mention", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [
        { type: "text", content: "see ", start: 0, end: 4 },
        { type: "file", path: "one.ts", content: "@one.ts", start: 4, end: 11 },
        { type: "text", content: " ", start: 11, end: 12 },
      ],
      cursor: 12,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([state, setState])

    prompt.addMention({ type: "file", path: "two.ts", content: "@two.ts", start: 0, end: 0 })

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "file", path: "one.ts", content: "@one.ts", start: 4, end: 11 },
      { type: "text", content: " ", start: 11, end: 12 },
      { type: "file", path: "two.ts", content: "@two.ts", start: 12, end: 19 },
      { type: "text", content: " ", start: 19, end: 20 },
    ])
    expect(prompt.state.cursor).toBe(20)
  })

  test("inserts at the cursor instead of replacing an email-like @", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "user@host more", start: 0, end: 14 }],
      cursor: 14,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([state, setState])

    prompt.addMention({ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 0 })

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "user@host more", start: 0, end: 14 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 14, end: 25 },
      { type: "text", content: " ", start: 25, end: 26 },
    ])
    expect(prompt.state.cursor).toBe(26)
  })

  test("mutates context, attachments, and model through shared actions", () => {
    const prompt = createPromptStore()
    const context = { key: "file:src/index.ts", type: "file" as const, path: "src/index.ts" }

    prompt.addContext(context)
    prompt.addContext(context)
    prompt.addMention({ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 0 })
    prompt.removeAttachment("attachment-1")
    prompt.setVariant("thinking")

    expect(prompt.state.context.items).toEqual([context])
    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 3, end: 14 },
      { type: "text", content: " ", start: 14, end: 15 },
    ])
    expect(prompt.state.model?.variant).toBe("thinking")

    prompt.removeContext(context.key)
    prompt.setPrompt([{ type: "text", content: "old", start: 0, end: 3 }], 3)
    prompt.setModel(undefined)

    expect(prompt.state.context.items).toEqual([])
    expect(prompt.state.prompt).toEqual([{ type: "text", content: "old", start: 0, end: 3 }])
    expect(prompt.state.model).toBeUndefined()
  })

  test("resets the prompt and cursor", () => {
    const prompt = createPromptStore()

    prompt.reset()

    expect(prompt.state.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(prompt.state.cursor).toBe(0)
  })
})
