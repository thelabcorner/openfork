import { afterEach, beforeEach, expect, test } from "bun:test"
import { suspendMarkdownDomWork } from "./markdown-suspend"

class FakeElement {
  dataset: Record<string, string> = {}
  children: FakeElement[] = []
  attributes = new Set<string>()
  textContent = ""
  constructor(key?: string, text = "") {
    if (key) this.dataset.markdownKey = key
    this.textContent = text
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase())
      delete this.dataset[key]
    }
  }
}

const original = globalThis.HTMLElement
beforeEach(() => Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: FakeElement }))
afterEach(() => Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: original }))

test("visibility suspension preserves already painted streaming Markdown while canceling pending work", () => {
  const root = new FakeElement()
  const live = new FakeElement("streaming", "Full previously painted assistant message")
  const completed = new FakeElement("completed", "Prior completed block")
  live.dataset.markdownHash = "in-progress"
  live.dataset.markdownPending = "true"
  completed.dataset.markdownHash = "committed"
  root.children.push(completed, live)
  const active = new Set(["streaming"])
  const canceled: string[] = []
  expect(suspendMarkdownDomWork(root as unknown as HTMLElement, active, (key) => canceled.push(key))).toBe(true)
  expect(canceled).toEqual(["streaming"])
  expect(active.size).toBe(0)
  expect(root.children).toEqual([completed, live])
  expect(live.textContent).toBe("Full previously painted assistant message")
  expect(live.dataset.markdownHash).toBeUndefined()
  expect(live.dataset.markdownPending).toBeUndefined()
  expect(completed.dataset.markdownHash).toBe("committed")
})

test("no active DOM work does not change completed message content", () => {
  const root = new FakeElement()
  const completed = new FakeElement("completed", "stable")
  completed.dataset.markdownHash = "committed"
  root.children.push(completed)
  expect(suspendMarkdownDomWork(root as unknown as HTMLElement, new Set(), () => {
    throw new Error("unexpected cancel")
  })).toBe(false)
  expect(completed.dataset.markdownHash).toBe("committed")
  expect(completed.textContent).toBe("stable")
})

test("cancels orphan work keys without touching unrelated painted DOM", () => {
  const root = new FakeElement()
  const completed = new FakeElement("completed", "important")
  root.children.push(completed)
  const active = new Set(["unmounted"])
  const canceled: string[] = []
  expect(suspendMarkdownDomWork(root as unknown as HTMLElement, active, (key) => canceled.push(key))).toBe(true)
  expect(canceled).toEqual(["unmounted"])
  expect(completed.textContent).toBe("important")
  expect(active.size).toBe(0)
})
