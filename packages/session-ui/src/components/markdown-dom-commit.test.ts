import { afterEach, expect, test } from "bun:test"
import {
  MARKDOWN_DOM_COMMIT_CHARS,
  MARKDOWN_DOM_COMMIT_FRAME_STEPS,
  MARKDOWN_DOM_COMMIT_NODES,
  MARKDOWN_DOM_COMMIT_MAX_BYTES,
  MARKDOWN_DOM_COMMIT_MAX_JOBS,
  cancelMarkdownDomCommit,
  canCommitMarkdownDom,
  commitMarkdownDom,
  markdownDomCommitSnapshot,
  resumeMarkdownDomCommit,
  subscribeMarkdownDomCapacity,
} from "./markdown-dom-commit"

class FakeNode {
  static TEXT_NODE = 3
  static ELEMENT_NODE = 1
  static DOCUMENT_FRAGMENT_NODE = 11
  nodeType = 1
  nodeValue: string | null = null
  childNodes: FakeNode[] = []
  parentNode?: FakeNode
  attributes = new Set<string>()
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  isConnected = true
  constructor(nodeType = 1, value: string | null = null) {
    this.nodeType = nodeType
    this.nodeValue = value
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === FakeNode.ELEMENT_NODE)
  }
  get firstChild() {
    return this.childNodes[0]
  }
  get nextSibling(): FakeNode | undefined {
    if (!this.parentNode) return undefined
    return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1]
  }
  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  cloneNode(deep = false) {
    const copy = new FakeNode(this.nodeType, this.nodeValue)
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true))
    return copy
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
}

class FakeTemplate extends FakeNode {
  content = new FakeNode(FakeNode.DOCUMENT_FRAGMENT_NODE)
  private value = ""
  get innerHTML() {
    return this.value
  }
  set innerHTML(value: string) {
    this.value = value
    if (value === "empty-text-fixture") {
      this.content.appendChild(new FakeNode(FakeNode.TEXT_NODE, ""))
      this.content.appendChild(new FakeNode(FakeNode.TEXT_NODE, "after-empty"))
    } else if (value) this.content.appendChild(new FakeNode(FakeNode.TEXT_NODE, value))
  }
}

const original = {
  document: globalThis.document,
  Node: globalThis.Node,
  HTMLElement: globalThis.HTMLElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
}
let frames: Array<FrameRequestCallback> = []

function installDom() {
  frames = []
  Object.assign(globalThis, {
    Node: FakeNode,
    HTMLElement: FakeNode,
    requestAnimationFrame: (callback: FrameRequestCallback) => (frames.push(callback), frames.length),
    document: {
      visibilityState: "visible",
      createTextNode: (text: string) => new FakeNode(FakeNode.TEXT_NODE, text),
      createElement: () => new FakeTemplate(),
    },
  })
}

function restoreDom() {
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: original.document })
  Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: original.Node })
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: original.HTMLElement })
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: original.requestAnimationFrame,
  })
}

afterEach(restoreDom)

function addTextJob(key: string, text: string, priority: "background" | "visible" | "tail" = "visible") {
  const parent = new FakeNode() as unknown as HTMLElement
  const wrapper = new FakeNode() as unknown as HTMLElement
  ;(parent as unknown as FakeNode).appendChild(wrapper as unknown as FakeNode)
  const accepted = commitMarkdownDom({
    key,
    html: "",
    plainText: text,
    parent,
    wrapper,
    priority,
    isCurrent: () => true,
    complete: () => {},
  })
  return { accepted, parent: parent as unknown as FakeNode, wrapper: wrapper as unknown as FakeNode }
}

function drainFrames(limit = 1000) {
  let steps = 0
  while (frames.length && steps++ < limit) frames.shift()!(0)
  if (steps >= limit) throw new Error("Markdown commit queue did not drain")
}

test("large source strings use offset chunks and every frame stays within its character budget", () => {
  installDom()
  const huge = "x".repeat(400_000)
  const jobs = ["a", "b", "c", "d", "e", "f"].map((key) => addTextJob(key, huge, "visible"))
  expect(jobs.every((job) => job.accepted)).toBe(true)
  drainFrames()
  const snapshot = markdownDomCommitSnapshot()
  expect(snapshot.maxBatchChars).toBeLessThanOrEqual(MARKDOWN_DOM_COMMIT_CHARS)
  expect(snapshot.maxBatchNodes).toBeLessThanOrEqual(MARKDOWN_DOM_COMMIT_NODES)
  expect(snapshot.maxBatchSteps).toBeLessThanOrEqual(MARKDOWN_DOM_COMMIT_FRAME_STEPS)
  expect(snapshot.queuedJobs).toBe(0)
  expect(snapshot.completedJobs).toBeGreaterThanOrEqual(6)
  for (const job of jobs) {
    const contents = job.wrapper.childNodes.map((node) => node.nodeValue ?? "").join("")
    expect(contents).toBe(huge)
    expect(job.wrapper.childNodes.every((node) => (node.nodeValue?.length ?? 0) <= 16 * 1024)).toBe(true)
  }
})

test("over-capacity producers pause and receive one shared-capacity wake after draining", () => {
  installDom()
  const full = "f".repeat(64 * 1024)
  const admitted = Array.from({ length: MARKDOWN_DOM_COMMIT_MAX_JOBS }, (_, index) => addTextJob(`full-${index}`, full))
  expect(admitted.every((job) => job.accepted)).toBe(true)
  expect(markdownDomCommitSnapshot().queuedBytes).toBe(MARKDOWN_DOM_COMMIT_MAX_BYTES)
  expect(canCommitMarkdownDom(2)).toBe(false)
  expect(addTextJob("blocked", "blocked").accepted).toBe(false)
  let wakes = 0
  const subscriptions: Array<() => void> = []
  for (let index = 0; index < 80; index++) {
    let unsubscribe = () => {}
    unsubscribe = subscribeMarkdownDomCapacity(() => {
      wakes++
      unsubscribe()
    })
    subscriptions.push(unsubscribe)
  }
  drainFrames()
  expect(wakes).toBe(MARKDOWN_DOM_COMMIT_MAX_JOBS)
  expect(markdownDomCommitSnapshot().waitingComponents).toBe(80 - MARKDOWN_DOM_COMMIT_MAX_JOBS)
  const remaining = Array.from({ length: 16 }, (_, index) => addTextJob(`second-wave-${index}`, "x"))
  expect(remaining.every((job) => job.accepted)).toBe(true)
  drainFrames()
  expect(wakes).toBe(80)
  expect(markdownDomCommitSnapshot().queuedBytes).toBe(0)
  expect(addTextJob("recovered", "recovered").accepted).toBe(true)
  drainFrames()
  subscriptions.forEach((unsubscribe) => unsubscribe())
})

test("stale and cancelled jobs are removed before writing, and replacement keys converge", () => {
  installDom()
  const staleParent = new FakeNode() as unknown as HTMLElement
  const staleWrapper = new FakeNode() as unknown as HTMLElement
  ;(staleParent as unknown as FakeNode).appendChild(staleWrapper as unknown as FakeNode)
  expect(
    commitMarkdownDom({
      key: "stale",
      html: "",
      plainText: "never commit",
      parent: staleParent,
      wrapper: staleWrapper,
      priority: "visible",
      isCurrent: () => false,
      complete: () => {},
    }),
  ).toBe(true)
  const cancelled = addTextJob("cancel", "cancel me")
  cancelMarkdownDomCommit("cancel")
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(1)
  const replaced = addTextJob("replace", "old")
  const replacement = addTextJob("replace", "new")
  expect(replacement.accepted).toBe(true)
  drainFrames()
  expect(staleWrapper.childNodes).toHaveLength(0)
  expect(cancelled.wrapper.childNodes).toHaveLength(0)
  expect(replaced.wrapper.childNodes).toHaveLength(0)
  expect(replacement.wrapper.childNodes.map((node) => node.nodeValue).join("")).toBe("new")
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(0)
})

test("document-hidden state pauses commits until a visible consumer resumes the shared scheduler", () => {
  installDom()
  const doc = globalThis.document as unknown as { hidden: boolean }
  doc.hidden = true
  const job = addTextJob("hidden", "defer while minimized")
  expect(job.accepted).toBe(true)
  expect(frames).toHaveLength(0)
  expect(job.wrapper.childNodes).toHaveLength(0)
  doc.hidden = false
  resumeMarkdownDomCommit()
  drainFrames()
  expect(job.wrapper.childNodes.map((node) => node.nodeValue).join("")).toBe("defer while minimized")
})

test("rich template parsing is byte-admitted and limited to one parse per frame", () => {
  installDom()
  const source = `<p>${"r".repeat(64 * 1024 - 7)}</p>`
  const makeRich = (key: string) => {
    const parent = new FakeNode() as unknown as HTMLElement
    const wrapper = new FakeNode() as unknown as HTMLElement
    ;(parent as unknown as FakeNode).appendChild(wrapper as unknown as FakeNode)
    return commitMarkdownDom({
      key,
      html: source,
      parent,
      wrapper,
      priority: "visible",
      isCurrent: () => true,
      complete: () => {},
    })
  }
  expect(makeRich("rich-1")).toBe(true)
  expect(makeRich("rich-2")).toBe(true)
  expect(makeRich("rich-3")).toBe(true)
  drainFrames()
  expect(markdownDomCommitSnapshot().maxRichParsesPerFrame).toBe(1)
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(0)
})

test("empty parsed text nodes are consumed and do not strand following siblings", () => {
  installDom()
  const parent = new FakeNode() as unknown as HTMLElement
  const wrapper = new FakeNode() as unknown as HTMLElement
  ;(parent as unknown as FakeNode).appendChild(wrapper as unknown as FakeNode)
  expect(
    commitMarkdownDom({
      key: "empty-text",
      html: "empty-text-fixture",
      parent,
      wrapper,
      priority: "visible",
      isCurrent: () => true,
      complete: () => {},
    }),
  ).toBe(true)
  drainFrames()
  expect(Array.from(wrapper.childNodes, (node) => node.nodeValue ?? "").join("")).toBe("after-empty")
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(0)
})

test("token jobs append bounded chunks and fairly advance several visible code blocks", () => {
  installDom()
  const output: FakeNode[] = []
  for (const key of ["dense-a", "dense-b", "dense-c"]) {
    const parent = new FakeNode()
    const wrapper = new FakeNode()
    const target = new FakeNode()
    parent.appendChild(wrapper)
    wrapper.appendChild(target)
    output.push(target)
    expect(
      commitMarkdownDom({
        key,
        html: "",
        tokens: [[key.repeat(8_000), ""]],
        bytes: key.length * 16_000,
        tokenSpan: ([text]) => new FakeNode(FakeNode.ELEMENT_NODE, text) as unknown as HTMLElement,
        target: target as unknown as HTMLElement,
        parent: parent as unknown as HTMLElement,
        wrapper: wrapper as unknown as HTMLElement,
        priority: "visible",
        isCurrent: () => true,
        complete: () => {},
      }),
    ).toBe(true)
  }
  frames.shift()!(0)
  expect(output.every((target) => target.childNodes.length > 0)).toBe(true)
  expect(markdownDomCommitSnapshot().maxBatchChars).toBeLessThanOrEqual(MARKDOWN_DOM_COMMIT_CHARS)
  expect(markdownDomCommitSnapshot().maxBatchNodes).toBeLessThanOrEqual(MARKDOWN_DOM_COMMIT_NODES)
  drainFrames()
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(0)
  expect(output.map((target) => target.childNodes.map((span) => span.childNodes.map((node) => node.nodeValue).join("")).join(""))).toEqual([
    "dense-a".repeat(8_000),
    "dense-b".repeat(8_000),
    "dense-c".repeat(8_000),
  ])
})

test("a token split across frames keeps one stable span when the next generation appends", () => {
  installDom()
  const parent = new FakeNode()
  const wrapper = new FakeNode()
  const code = new FakeNode()
  parent.appendChild(wrapper)
  wrapper.appendChild(code)
  const token = "stable-code-".repeat(20_000)
  const addTokens = (key: string, tokens: [string, string][]) =>
    commitMarkdownDom({
      key,
      html: "",
      tokens,
      bytes: tokens.reduce((total, [text]) => total + text.length * 2, 0),
      tokenSpan: ([, style]) => new FakeNode(FakeNode.ELEMENT_NODE, style) as unknown as HTMLElement,
      target: code as unknown as HTMLElement,
      parent: parent as unknown as HTMLElement,
      wrapper: wrapper as unknown as HTMLElement,
      priority: "visible",
      isCurrent: () => true,
      complete: () => {},
    })

  expect(addTokens("stable-prefix", [["", ""], [token, "color:red"]])).toBe(true)
  frames.shift()!(0)
  const emptyStableNode = code.childNodes[0]
  const stableNode = code.childNodes[1]
  expect(emptyStableNode).toBeDefined()
  expect(stableNode).toBeDefined()
  expect(code.childNodes).toHaveLength(2)
  expect(addTokens("next-generation", [["next", "color:blue"]])).toBe(true)
  drainFrames()
  expect(code.childNodes[0]).toBe(emptyStableNode)
  expect(code.childNodes[1]).toBe(stableNode)
  expect(code.childNodes.map((span) => span.childNodes.map((node) => node.nodeValue).join("")).join("")).toBe(
    `${token}next`,
  )
  expect(markdownDomCommitSnapshot().queuedJobs).toBe(0)
})
