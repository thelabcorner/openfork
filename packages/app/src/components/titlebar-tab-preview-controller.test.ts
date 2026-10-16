import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTabPreviewController, type TabPreviewIntent } from "./titlebar-tab-preview-controller"

const tick = (ms = 8) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const anchor = () => {
  const element = document.createElement("div")
  let hovered = true
  const originalMatches = element.matches.bind(element)
  element.matches = (selector) => selector === ":hover" ? hovered : originalMatches(selector)
  document.body.append(element)
  return { element, setHovered: (next: boolean) => { hovered = next }, dispose: () => element.remove() }
}
const intent = (element: HTMLElement, id: string) => ({
  anchor: element,
  tab: { type: "session", server: "test", sessionId: id },
  serverCtx: () => undefined,
  serverLabel: () => undefined,
}) as TabPreviewIntent
const setup = (delay = 0, closeDelay = 1) => {
  let dispose = () => {}
  const preview = createRoot((done) => {
    dispose = done
    return createTabPreviewController({ delay: () => delay, closeDelay })
  })
  return { preview, dispose }
}

test("one shared owner repopulates instead of opening a second inspector", async () => {
  const first = anchor()
  const second = anchor()
  const { preview, dispose } = setup()
  try {
    preview.hover(intent(first.element, "one"))
    await tick()
    expect(preview.current()?.tab.type).toBe("session")
    expect((preview.current()?.tab as { sessionId: string }).sessionId).toBe("one")
    preview.leave(first.element)
    preview.hover(intent(second.element, "two"))
    expect((preview.current()?.tab as { sessionId: string }).sessionId).toBe("two")
    await tick()
    expect(preview.current()?.anchor).toBe(second.element)
  } finally {
    dispose()
    first.dispose()
    second.dispose()
  }
})

test("uncompleted dwell never mounts an inspector, even after disposal", async () => {
  const first = anchor()
  const { preview, dispose } = setup(15)
  try {
    preview.hover(intent(first.element, "one"))
    first.setHovered(false)
    preview.leave(first.element)
    await tick(25)
    expect(preview.current()).toBeUndefined()
    first.setHovered(true)
    preview.hover(intent(first.element, "one"))
    dispose()
    await tick(25)
    expect(preview.current()).toBeUndefined()
  } finally {
    dispose()
    first.dispose()
  }
})

test("the interactive gutter keeps the same inspector alive until the card exits", async () => {
  const first = anchor()
  const { preview, dispose } = setup(0, 3)
  try {
    preview.hover(intent(first.element, "one"))
    await tick()
    first.setHovered(false)
    preview.leave(first.element)
    preview.contentEnter()
    await tick()
    expect(preview.current()?.anchor).toBe(first.element)
    preview.contentLeave()
    await tick()
    expect(preview.current()).toBeUndefined()
  } finally {
    dispose()
    first.dispose()
  }
})

test("context menus lock the shared card and do not repopulate it prematurely", async () => {
  const first = anchor()
  const second = anchor()
  const { preview, dispose } = setup()
  try {
    preview.hover(intent(first.element, "one"))
    await tick()
    preview.contextMenuOpenChange(true)
    first.setHovered(false)
    preview.leave(first.element)
    preview.hover(intent(second.element, "two"))
    await tick()
    expect(preview.current()?.anchor).toBe(first.element)
    preview.contextMenuOpenChange(false)
    await tick(40)
    expect(preview.current()).toBeUndefined()
  } finally {
    dispose()
    first.dispose()
    second.dispose()
  }
})

test("forced dismissal on pointerdown cannot suppress tab clicks or retain old content", async () => {
  const first = anchor()
  const { preview, dispose } = setup()
  try {
    preview.hover(intent(first.element, "one"))
    await tick()
    preview.close(true)
    expect(preview.current()).toBeUndefined()
    preview.hover(intent(first.element, "one"))
    await tick()
    expect(preview.current()?.anchor).toBe(first.element)
  } finally {
    dispose()
    first.dispose()
  }
})

test("force closing a hovered card or context menu releases locks for the next tab", async () => {
  const first = anchor()
  const second = anchor()
  const { preview, dispose } = setup()
  try {
    preview.hover(intent(first.element, "one"))
    await tick()
    preview.contentEnter()
    preview.contextMenuOpenChange(true)
    preview.close(true)
    expect(preview.current()).toBeUndefined()
    preview.hover(intent(second.element, "two"))
    await tick()
    expect(preview.current()?.anchor).toBe(second.element)
    second.setHovered(false)
    preview.leave(second.element)
    await tick()
    expect(preview.current()).toBeUndefined()
  } finally {
    dispose()
    first.dispose()
    second.dispose()
  }
})
