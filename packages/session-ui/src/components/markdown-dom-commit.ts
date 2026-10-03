import type { MarkdownWorkPriority } from "./markdown-worker-admission"
import type { MarkdownToken } from "./markdown-worker-protocol"

export const MARKDOWN_DOM_COMMIT_CHARS = 64 * 1024
export const MARKDOWN_DOM_COMMIT_NODES = 128
export const MARKDOWN_DOM_COMMIT_MAX_JOBS = 64
export const MARKDOWN_DOM_COMMIT_MAX_BYTES = 8 * 1024 * 1024
export const MARKDOWN_DOM_COMMIT_MAX_JOB_BYTES = 1024 * 1024
export const MARKDOWN_DOM_COMMIT_FRAME_STEPS = 128
export const MARKDOWN_DOM_COMMIT_FRAME_MS = 4
const TEXT_NODE_CHARS = 16 * 1024

type CommitInput = {
  key: string
  html: string
  plainText?: string
  tokens?: MarkdownToken[]
  tokenSpan?: (token: MarkdownToken) => HTMLElement
  tokenProgress?: (count: number) => void
  target?: HTMLElement
  bytes?: number
  parent: HTMLElement
  wrapper: HTMLElement
  priority: MarkdownWorkPriority
  isCurrent: () => boolean
  complete: () => void
}

type NodeTask = { source?: Node; text?: string; parent: Node; offset?: number }
type CommitJob =
  & CommitInput
  & {
      template?: HTMLTemplateElement
      stack: NodeTask[]
      bytes: number
      age: number
      tokenIndex: number
      tokenOffset: number
      tokenElement?: HTMLElement
    }

const jobs = new Map<string, CommitJob>()
const queues: Record<MarkdownWorkPriority, CommitJob[]> = { background: [], visible: [], tail: [] }
const capacityListeners = new Set<() => void>()
let scheduled = false
let queuedBytes = 0
let frameCount = 0
let maxBatchChars = 0
let maxBatchNodes = 0
let maxBatchSteps = 0
let maxRichParsesPerFrame = 0
let completedJobs = 0
let frameEpoch = 0
let consecutiveTailSteps = 0

function schedule() {
  if (scheduled || jobs.size === 0) return
  if (document.hidden) return
  scheduled = true
  const run = () => {
    scheduled = false
    flush()
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run)
    return
  }
  setTimeout(run, 16)
}

function chooseJob() {
  const tail = queues.tail
  const visible = queues.visible
  const background = queues.background
  const firstBackground = background[0]
  if (firstBackground && frameEpoch - firstBackground.age >= 120) {
    consecutiveTailSteps = 0
    return background.shift()
  }
  if (visible.length && (consecutiveTailSteps >= 4 || tail.length === 0)) {
    consecutiveTailSteps = 0
    return visible.shift()
  }
  if (tail.length) {
    consecutiveTailSteps++
    return tail.shift()
  }
  if (visible.length) {
    consecutiveTailSteps = 0
    return visible.shift()
  }
  if (background.length) {
    consecutiveTailSteps = 0
    return background.shift()
  }
}

function removeJob(job: CommitJob) {
  if (!jobs.delete(job.key)) return false
  queuedBytes -= job.bytes
  for (const queue of Object.values(queues)) {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }
  return true
}

function wakeOneWaiter() {
  const listener = capacityListeners.values().next().value as (() => void) | undefined
  if (!listener) return
  capacityListeners.delete(listener)
  listener()
}

function flush() {
  if (document.hidden) return
  frameEpoch++
  const started = performance.now()
  let chars = 0
  let nodes = 0
  let steps = 0
  let richParses = 0
  const frameStartJobs = jobs.size
  while (
    chars < MARKDOWN_DOM_COMMIT_CHARS &&
    nodes < MARKDOWN_DOM_COMMIT_NODES &&
    steps < MARKDOWN_DOM_COMMIT_FRAME_STEPS &&
    performance.now() - started < MARKDOWN_DOM_COMMIT_FRAME_MS
  ) {
    const job = chooseJob()
    if (!job) break
    steps++
    if (!job.isCurrent() || !job.wrapper.isConnected || job.parent.children.length === 0) {
      removeJob(job)
      job.wrapper.removeAttribute("data-markdown-pending")
      wakeOneWaiter()
      continue
    }
    if (job.tokens) {
      const token = job.tokens[job.tokenIndex]
      if (!token) {
        removeJob(job)
        job.wrapper.removeAttribute("data-markdown-pending")
        completedJobs++
        job.complete()
        wakeOneWaiter()
        continue
      }
      const text = token[0]
      if (!text.length) {
        if (nodes >= MARKDOWN_DOM_COMMIT_NODES) {
          queues[job.priority].push(job)
          break
        }
        const span = job.tokenSpan?.(["", token[1]])
        if (!span) {
          removeJob(job)
          wakeOneWaiter()
          continue
        }
        ;(job.target ?? job.wrapper).appendChild(span)
        nodes++
        job.tokenIndex++
        job.tokenOffset = 0
        job.tokenProgress?.(job.tokenIndex)
      } else {
        const remaining = MARKDOWN_DOM_COMMIT_CHARS - chars
        let end = Math.min(text.length, job.tokenOffset + TEXT_NODE_CHARS, job.tokenOffset + remaining)
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
        if (end <= job.tokenOffset) {
          queues[job.priority].push(job)
          break
        }
        const needsSpan = job.tokenElement === undefined
        if (nodes + (needsSpan ? 2 : 1) > MARKDOWN_DOM_COMMIT_NODES) {
          queues[job.priority].push(job)
          break
        }
        const span = job.tokenElement ?? job.tokenSpan?.(["", token[1]])
        if (!span) {
          removeJob(job)
          wakeOneWaiter()
          continue
        }
        if (needsSpan) {
          (job.target ?? job.wrapper).appendChild(span)
          job.tokenElement = span
          nodes++
        }
        span.appendChild(document.createTextNode(text.slice(job.tokenOffset, end)))
        chars += end - job.tokenOffset
        nodes++
        job.tokenOffset = end
        if (end === text.length) {
          job.tokenIndex++
          job.tokenOffset = 0
          job.tokenElement = undefined
          job.tokenProgress?.(job.tokenIndex)
        }
      }
      if (job.tokenIndex < job.tokens.length) queues[job.priority].push(job)
      else {
        removeJob(job)
        job.wrapper.removeAttribute("data-markdown-pending")
        completedJobs++
        job.complete()
        wakeOneWaiter()
      }
      continue
    }
    const task = job.stack.pop()
    if (!task) {
      removeJob(job)
      job.wrapper.removeAttribute("data-markdown-pending")
      completedJobs++
      job.complete()
      wakeOneWaiter()
      continue
    }
    const { source, parent } = task
    if (!job.template && job.plainText === undefined) {
      // Parsing is intentionally deferred until a fair scheduler turn. Rich
      // output is capped before admission, so this one synchronous browser
      // parse is bounded independently of the original message size.
      const template = document.createElement("template")
      template.innerHTML = job.html
      job.template = template
      job.stack.push({ source: template.content, parent: job.wrapper })
      richParses++
      if (job.stack.length) queues[job.priority].push(job)
      else {
        removeJob(job)
        job.wrapper.removeAttribute("data-markdown-pending")
        completedJobs++
        job.complete()
        wakeOneWaiter()
      }
      // A rich HTML parse is one indivisible browser operation. Do at most one
      // capped parse per frame, then yield before cloning any of its nodes.
      break
    }
    if (task.text !== undefined || source?.nodeType === Node.TEXT_NODE) {
      const text = task.text ?? source?.nodeValue ?? ""
      const start = task.offset ?? 0
      const remaining = MARKDOWN_DOM_COMMIT_CHARS - chars
      let end = Math.min(text.length, start + TEXT_NODE_CHARS, start + remaining)
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
      if (end <= start) {
        if (text.length === start) {
          // Empty DOM text nodes still have a sibling to visit. Consume this
          // task without manufacturing a zero-length node or requeue loop.
          if (source && start === 0 && source.nextSibling) job.stack.push({ source: source.nextSibling, parent })
        } else {
          // A surrogate pair cannot be split across the remaining frame
          // budget; retry it in the next frame when the full budget resets.
          job.stack.push(task)
          queues[job.priority].push(job)
          break
        }
      } else {
        parent.appendChild(document.createTextNode(text.slice(start, end)))
        chars += end - start
        nodes++
        if (source && start === 0 && source.nextSibling) job.stack.push({ source: source.nextSibling, parent })
        if (end < text.length)
          job.stack.push(task.text === undefined ? { source, parent, offset: end } : { text, parent, offset: end })
      }
    } else if (source?.nodeType === Node.ELEMENT_NODE) {
      const clone = source.cloneNode(false) as Element
      parent.appendChild(clone)
      if (source.nextSibling) job.stack.push({ source: source.nextSibling, parent })
      if (source.firstChild) job.stack.push({ source: source.firstChild, parent: clone })
      nodes++
    } else if (source?.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      if (source.firstChild) job.stack.push({ source: source.firstChild, parent })
    } else if (source) {
      parent.appendChild(source.cloneNode(true))
      if (source.nextSibling) job.stack.push({ source: source.nextSibling, parent })
      nodes++
    }
    if (job.stack.length) queues[job.priority].push(job)
    else {
      removeJob(job)
      job.wrapper.removeAttribute("data-markdown-pending")
      completedJobs++
      job.complete()
      wakeOneWaiter()
    }
  }
  if (chars > maxBatchChars) maxBatchChars = chars
  if (nodes > maxBatchNodes) maxBatchNodes = nodes
  if (steps > maxBatchSteps) maxBatchSteps = steps
  if (richParses > maxRichParsesPerFrame) maxRichParsesPerFrame = richParses
  if (chars > 0 || nodes > 0) frameCount++
  // A malformed empty node task can finish without consuming the frame budget.
  // This cap ensures stale/empty jobs cannot make a flush spin forever.
  if (jobs.size && frameStartJobs > 0) schedule()
}

/** Resume jobs paused by the document-wide hidden state from a visible consumer. */
export function resumeMarkdownDomCommit() {
  if (!document.hidden) schedule()
}

export function canCommitMarkdownDom(bytes: number) {
  return (
    bytes <= MARKDOWN_DOM_COMMIT_MAX_JOB_BYTES &&
    jobs.size < MARKDOWN_DOM_COMMIT_MAX_JOBS &&
    queuedBytes + bytes <= MARKDOWN_DOM_COMMIT_MAX_BYTES
  )
}

/** Add bounded Markdown HTML or source text to the live DOM in fair frame batches. */
export function commitMarkdownDom(input: CommitInput) {
  cancelMarkdownDomCommit(input.key)
  // Large plain source strings are already retained by the message model. The
  // job keeps only a source reference and an offset, so charge a bounded cursor
  // window instead of rejecting or copying the entire string.
  const bytes = input.bytes ??
    (input.tokens
      ? input.tokens.reduce((total, token) => total + token[0].length * 2 + token[1].length * 2 + 32, 0)
      : input.plainText === undefined
        ? input.html.length * 2
        : Math.min(input.plainText.length * 2, MARKDOWN_DOM_COMMIT_MAX_JOB_BYTES))
  if (!canCommitMarkdownDom(bytes)) return false
  const stack: NodeTask[] = []
  if (input.plainText === undefined && !input.tokens) {
    stack.push({ parent: input.wrapper })
  } else if (input.plainText !== undefined) {
    input.wrapper.style.whiteSpace = "pre-line"
    stack.push({ text: input.plainText, parent: input.target ?? input.wrapper, offset: 0 })
  }
  const job: CommitJob = { ...input, stack, bytes, age: frameEpoch, tokenIndex: 0, tokenOffset: 0 }
  jobs.set(input.key, job)
  queues[input.priority].push(job)
  queuedBytes += bytes
  schedule()
  return true
}

export function cancelMarkdownDomCommit(key: string) {
  const job = jobs.get(key)
  if (!job) return
  removeJob(job)
  wakeOneWaiter()
}

/** Subscribe only while a component is backpressured; one shared owner wakes it when capacity changes. */
export function subscribeMarkdownDomCapacity(callback: () => void) {
  // Demand is only registered after a visible component hit the bounded job or
  // byte ceiling. Keep one lightweight wake per blocked component and wake one
  // FIFO waiter per released slot; never silently strand an overflow consumer.
  capacityListeners.add(callback)
  return () => capacityListeners.delete(callback)
}

export function markdownDomCommitSnapshot() {
  return {
    queuedJobs: jobs.size,
    queuedBytes,
    waitingComponents: capacityListeners.size,
    frameCount,
    maxBatchChars,
    maxBatchNodes,
    maxBatchSteps,
    maxRichParsesPerFrame,
    completedJobs,
  }
}
