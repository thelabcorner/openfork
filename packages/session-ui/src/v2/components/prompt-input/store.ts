import { batch, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import type {
  PromptInputV2AgentPart,
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2FilePart,
  PromptInputV2Model,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2SkillPart,
} from "./types"

export type PromptInputV2StoreTuple = [
  Store<PromptInputV2PersistedState> | Accessor<Store<PromptInputV2PersistedState>>,
  SetStoreFunction<PromptInputV2PersistedState>,
]

export type PromptInputV2StoreInput = PromptInputV2StoreTuple | Accessor<PromptInputV2StoreTuple>

export function createPromptInputV2Store(input: PromptInputV2StoreInput) {
  const tuple = () => (typeof input === "function" ? input() : input)
  const store = () => {
    const value = tuple()[0]
    return typeof value === "function" ? value() : value
  }
  const setStore = () => tuple()[1]

  return {
    get state() {
      return store()
    },
    setPrompt(prompt: PromptInputV2Prompt, cursor?: number) {
      const current = store()
      const cursorChanged = cursor !== undefined && cursor !== current.cursor
      const promptEqual = isPromptInputV2PromptEqual(current.prompt, prompt)
      if (promptEqual && !cursorChanged) return
      batch(() => {
        if (!promptEqual) setStore()("prompt", prompt)
        if (cursor !== undefined) setStore()("cursor", cursor)
      })
    },
    setCursor(cursor: number) {
      setStore()("cursor", cursor)
    },
    setText(content: string) {
      batch(() => {
        setStore()("prompt", (prompt) => [
          { type: "text", content, start: 0, end: content.length },
          ...prompt.filter((part) => part.type !== "text"),
        ])
        setStore()("cursor", content.length)
      })
    },
    addText(content: string) {
      const cursor = store().cursor ?? promptLength(store().prompt)
      batch(() => {
        setStore()("prompt", (prompt) => insertText(prompt, cursor, content))
        setStore()("cursor", cursor + content.length)
      })
    },
    reset() {
      batch(() => {
        setStore()("prompt", [{ type: "text", content: "", start: 0, end: 0 }])
        setStore()("cursor", 0)
      })
    },
    setModel(model: PromptInputV2Model | undefined) {
      setStore()("model", model)
    },
    setVariant(variant: string | null) {
      if (store().model) setStore()("model", "variant", variant)
    },
    addContext(item: PromptInputV2Comment) {
      if (store().context.items.some((entry) => entry.key === item.key)) return
      setStore()("context", "items", (items) => [...items, item])
    },
    removeContext(key: string) {
      setStore()("context", "items", (items) => items.filter((item) => item.key !== key))
    },
    addMention(mention: PromptInputV2FilePart | PromptInputV2AgentPart | PromptInputV2SkillPart) {
      const text = store()
        .prompt.map((part) => ("content" in part ? part.content : ""))
        .join("")
      const cursor = store().cursor ?? text.length
      const { start, end } = mentionQueryRange(text, cursor)
      batch(() => {
        setStore()("prompt", insertMention(store().prompt, start, end, mention))
        setStore()("cursor", start + mention.content.length + 1)
      })
    },
    addAttachment(attachment: PromptInputV2Attachment) {
      setStore()("prompt", (prompt) => [...prompt, attachment])
    },
    removeAttachment(id: string) {
      setStore()("prompt", (parts) => parts.filter((part) => part.type !== "image" || part.id !== id))
    },
  }
}

export type PromptInputV2Store = ReturnType<typeof createPromptInputV2Store>

function insertText(prompt: PromptInputV2Prompt, cursor: number, content: string): PromptInputV2Prompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const start = position
    position += part.content.length
    if (inserted) return [part]
    if (part.type === "text" && cursor >= start && cursor <= position) {
      inserted = true
      const offset = cursor - start
      return [{ ...part, content: part.content.slice(0, offset) + content + part.content.slice(offset) }]
    }
    if (cursor > start) return [part]
    inserted = true
    return [{ type: "text", content, start: 0, end: 0 }, part]
  })
  if (!inserted) parts.push({ type: "text", content, start: 0, end: 0 })
  return withOffsets(parts)
}

function mentionQueryRange(text: string, cursor: number) {
  const prefix = text.slice(0, cursor)
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return { start: cursor, end: cursor }
  return { start: cursor - (match[1]?.length ?? 0) - 1, end: cursor }
}

function insertMention(
  prompt: PromptInputV2Prompt,
  start: number,
  end: number,
  mention: PromptInputV2FilePart | PromptInputV2AgentPart | PromptInputV2SkillPart,
): PromptInputV2Prompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const partStart = position
    position += part.content.length
    if (inserted) return [part]
    if (part.type !== "text" || start < partStart || end > position) return [part]
    inserted = true
    const before = part.content.slice(0, start - partStart)
    const after = part.content.slice(end - partStart)
    return [
      ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
      mention,
      { type: "text" as const, content: ` ${after}`, start: 0, end: 0 },
    ]
  })
  if (!inserted) {
    parts.push(mention, { type: "text" as const, content: " ", start: 0, end: 0 })
  }
  return withOffsets(parts)
}

function withOffsets(prompt: PromptInputV2Prompt): PromptInputV2Prompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}

function promptLength(prompt: PromptInputV2Prompt) {
  return prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
}

function isPromptInputV2PromptEqual(a: PromptInputV2Prompt, b: PromptInputV2Prompt): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const partA = a[i]
    const partB = b[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "image" && partB.type === "image") {
      if (partA.id !== partB.id) return false
      continue
    }
    if ("content" in partA && "content" in partB) {
      if (partA.content !== partB.content) return false
      if (partA.type === "agent" && partB.type === "agent" && partA.name !== partB.name) return false
      if (partA.type === "file" && partB.type === "file") {
        if (partA.path !== partB.path) return false
        if (partA.mime !== partB.mime) return false
        if (partA.filename !== partB.filename) return false
      }
      continue
    }
    return false
  }
  return true
}
