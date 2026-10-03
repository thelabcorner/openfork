import { afterEach, expect, test } from "bun:test"
import { observeMarkdownVisibility } from "./markdown-visibility"

class FakeElement {
  isConnected = true
  parentElement: FakeElement | null = null
  attributes = new Map<string, string>()
  style = { display: "block", visibility: "visible", contentVisibility: "visible", opacity: "1" }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
}

class FakeIntersectionObserver {
  static current: FakeIntersectionObserver | undefined
  callback: IntersectionObserverCallback
  targets = new Set<Element>()
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.current = this
  }
  observe(element: Element) {
    this.targets.add(element)
  }
  unobserve(element: Element) {
    this.targets.delete(element)
  }
  disconnect() {
    this.targets.clear()
  }
  intersect(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

class FakeMutationObserver {
  static current: FakeMutationObserver | undefined
  static observeCalls = 0
  static disconnectCalls = 0
  callback: MutationCallback
  targets = new Set<Element>()
  records: MutationRecord[] = []
  constructor(callback: MutationCallback) {
    this.callback = callback
    FakeMutationObserver.current = this
  }
  observe(element: Element) {
    FakeMutationObserver.observeCalls++
    this.targets.add(element)
  }
  disconnect() {
    FakeMutationObserver.disconnectCalls++
    this.targets.clear()
  }
  takeRecords() {
    const records = this.records
    this.records = []
    return records
  }
  mutate(target: Element) {
    this.callback([{ target, type: "attributes" } as unknown as MutationRecord], this as unknown as MutationObserver)
  }
  queueMutation(target: Element) {
    this.records.push({ target, type: "attributes" } as unknown as MutationRecord)
  }
}

const original = {
  document: globalThis.document,
  IntersectionObserver: globalThis.IntersectionObserver,
  MutationObserver: globalThis.MutationObserver,
  getComputedStyle: globalThis.getComputedStyle,
}
let hiddenListener: (() => void) | undefined
let documentHidden = false
const styleReads = new Map<FakeElement, number>()

function installDom() {
  documentHidden = false
  hiddenListener = undefined
  styleReads.clear()
  FakeMutationObserver.observeCalls = 0
  FakeMutationObserver.disconnectCalls = 0
  Object.assign(globalThis, {
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
    getComputedStyle: (element: FakeElement) => {
      styleReads.set(element, (styleReads.get(element) ?? 0) + 1)
      return element.style
    },
    document: {
      hidden: false,
      documentElement: new FakeElement(),
      addEventListener: (_type: string, listener: () => void) => (hiddenListener = listener),
      removeEventListener: () => (hiddenListener = undefined),
    },
  })
}

function setDocumentHidden(hidden: boolean) {
  documentHidden = hidden
  ;(globalThis.document as unknown as { hidden: boolean }).hidden = hidden
  hiddenListener?.()
}

function restoreDom() {
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document })
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: original.IntersectionObserver,
  })
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    writable: true,
    value: original.MutationObserver,
  })
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: original.getComputedStyle,
  })
}

afterEach(restoreDom)

test("shared visibility blocks offscreen and minimized consumers, then resumes on activation", () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const ancestor = new FakeElement()
  ancestor.parentElement = root
  const element = new FakeElement()
  element.parentElement = ancestor
  let visibility: boolean | undefined
  const stop = observeMarkdownVisibility(element as unknown as Element, (value) => (visibility = value))
  expect(visibility).toBeUndefined()
  const observer = FakeIntersectionObserver.current!
  observer.intersect(element as unknown as Element, true)
  expect(visibility).toBe(true)

  setDocumentHidden(true)
  expect(visibility).toBe(false)
  setDocumentHidden(false)
  expect(visibility).toBe(true)

  ancestor.style.opacity = "0"
  FakeMutationObserver.current!.mutate(ancestor as unknown as Element)
  expect(visibility).toBe(false)
  ancestor.style.opacity = "1"
  FakeMutationObserver.current!.mutate(ancestor as unknown as Element)
  expect(visibility).toBe(true)
  stop()
  expect(observer.targets.size).toBe(0)
  expect(FakeMutationObserver.current!.targets.size).toBe(0)
})

test("document-hidden and aria-hidden states remain negative visibility invariants", () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const element = new FakeElement()
  element.parentElement = root
  element.attributes.set("aria-hidden", "true")
  let visibility = true
  const stop = observeMarkdownVisibility(element as unknown as Element, (value) => (visibility = value))
  FakeIntersectionObserver.current!.intersect(element as unknown as Element, true)
  expect(visibility).toBe(false)
  element.attributes.delete("aria-hidden")
  FakeMutationObserver.current!.mutate(element as unknown as Element)
  expect(visibility).toBe(true)
  setDocumentHidden(true)
  expect(visibility).toBe(false)
  stop()
})

test("dense teardown coalesces ancestor observer rebuilds into one linear reobserve pass", async () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const shared = new FakeElement()
  shared.parentElement = root
  const stops = Array.from({ length: 80 }, (_, index) => {
    const row = new FakeElement()
    row.parentElement = shared
    const element = new FakeElement()
    element.parentElement = row
    return observeMarkdownVisibility(element as unknown as Element, () => {})
  })
  const beforeObserves = FakeMutationObserver.observeCalls
  const beforeDisconnects = FakeMutationObserver.disconnectCalls

  for (const stop of stops.slice(0, 40)) stop()
  await Promise.resolve()

  expect(FakeMutationObserver.disconnectCalls - beforeDisconnects).toBe(1)
  // The remaining 40 rows contribute two private ancestors each; the shared
  // parent and document root are observed once for the whole batch.
  expect(FakeMutationObserver.observeCalls - beforeObserves).toBeLessThanOrEqual(82)
  expect(FakeMutationObserver.current!.targets.size).toBe(82)

  for (const stop of stops.slice(40)) stop()
  await Promise.resolve()
  expect(FakeMutationObserver.current!.targets.size).toBe(0)
})

test("a disconnected observer generation cannot publish into a rapid remount", () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const ancestor = new FakeElement()
  ancestor.parentElement = root
  const first = new FakeElement()
  first.parentElement = ancestor
  let firstVisible = false
  const stopFirst = observeMarkdownVisibility(first as unknown as Element, (value) => (firstVisible = value))
  const oldMutationObserver = FakeMutationObserver.current!
  FakeIntersectionObserver.current!.intersect(first as unknown as Element, true)
  expect(firstVisible).toBe(true)
  stopFirst()

  const second = new FakeElement()
  second.parentElement = ancestor
  let secondVisible = false
  const stopSecond = observeMarkdownVisibility(second as unknown as Element, (value) => (secondVisible = value))
  const currentMutationObserver = FakeMutationObserver.current!
  FakeIntersectionObserver.current!.intersect(second as unknown as Element, true)
  expect(secondVisible).toBe(true)

  ancestor.style.opacity = "0"
  oldMutationObserver.mutate(ancestor as unknown as Element)
  expect(secondVisible).toBe(true)
  currentMutationObserver.mutate(ancestor as unknown as Element)
  expect(secondVisible).toBe(false)
  stopSecond()
})

test("coalesced observer rebuild applies queued style changes to remaining subscribers", async () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const shared = new FakeElement()
  shared.parentElement = root
  const firstRow = new FakeElement()
  firstRow.parentElement = shared
  const first = new FakeElement()
  first.parentElement = firstRow
  const secondRow = new FakeElement()
  secondRow.parentElement = shared
  const second = new FakeElement()
  second.parentElement = secondRow
  const stopFirst = observeMarkdownVisibility(first as unknown as Element, () => {})
  let secondVisible = false
  const stopSecond = observeMarkdownVisibility(second as unknown as Element, (value) => (secondVisible = value))
  const mutationObserver = FakeMutationObserver.current!
  FakeIntersectionObserver.current!.intersect(first as unknown as Element, true)
  FakeIntersectionObserver.current!.intersect(second as unknown as Element, true)
  expect(secondVisible).toBe(true)

  stopFirst()
  shared.style.opacity = "0"
  mutationObserver.queueMutation(shared as unknown as Element)
  await Promise.resolve()

  expect(secondVisible).toBe(false)
  expect(mutationObserver.targets.has(shared as unknown as Element)).toBe(true)
  stopSecond()
})

test("document visibility changes share ancestor style reads across subscribers", () => {
  installDom()
  const root = (globalThis.document as unknown as { documentElement: FakeElement }).documentElement
  const shared = new FakeElement()
  shared.parentElement = root
  const stops = Array.from({ length: 32 }, () => {
    const element = new FakeElement()
    element.parentElement = shared
    const stop = observeMarkdownVisibility(element as unknown as Element, () => {})
    FakeIntersectionObserver.current!.intersect(element as unknown as Element, true)
    return stop
  })

  setDocumentHidden(true)
  styleReads.clear()
  setDocumentHidden(false)

  expect(styleReads.get(shared)).toBe(1)
  expect(styleReads.get(root)).toBe(1)
  stops.forEach((stop) => stop())
})
