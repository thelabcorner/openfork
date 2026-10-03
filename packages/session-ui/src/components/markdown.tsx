import { useI18n } from "@opencode-ai/ui/context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type ComponentProps,
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { canReusePendingBlock } from "./markdown-projection"
import { completedProjection, MARKDOWN_RICH_BLOCK_MAX_BYTES, type Block, type Projection } from "./markdown-stream"
import {
  disposeMarkdownProjection,
  disposeStreamingCode,
  highlightStreamingCode,
  type HostMarkdownProjection,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
  parseMarkdown,
  projectMarkdown,
  registerMarkdownOwnerKey,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import type { MarkdownWorkPriority } from "./markdown-worker-admission"
import { observeMarkdownVisibility } from "./markdown-visibility"
import {
  cancelMarkdownDomCommit,
  canCommitMarkdownDom,
  commitMarkdownDom,
  resumeMarkdownDomCommit,
  subscribeMarkdownDomCapacity,
} from "./markdown-dom-commit"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown, type MarkdownCacheEntry } from "./markdown-cache"
import {
  MARKDOWN_FRAME_WORK_MAX_JOB_BYTES,
  cancelMarkdownFrameWork,
  releaseMarkdownFrameWorkReservation,
  reserveMarkdownFrameWork,
  resumeMarkdownFrameWork,
  runMarkdownFrameWork,
  type MarkdownFrameWorkReservation,
} from "./markdown-frame-work"
import { inlineCodeKind } from "./markdown-inline-code-kind"
import {
  disposeMermaidBlocks,
  hydrateMermaidBlocks,
  isMermaidLanguage,
  mountMermaidBlock,
} from "./markdown-mermaid"
import { markdownTraceEnabled, traceMarkdown } from "./markdown-trace"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code">; plainText?: string; plainCode?: boolean })
  | {
      key: string
      mode: "code"
      raw: string
      src: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  cacheKey?: string
  blocks: RenderedBlock[]
  /** First block that may differ from the preceding rendered result. */
  changedFrom: number
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()
const renderedCodeSource = new WeakMap<HTMLElement, string>()
const MARKDOWN_CRITICAL_WORK_MAX_BYTES = MARKDOWN_RICH_BLOCK_MAX_BYTES
const MARKDOWN_RICH_HTML_MAX_BYTES = 256 * 1024
const MARKDOWN_DOM_COOPERATIVE_THRESHOLD = 16 * 1024
const MARKDOWN_PARSE_BATCH_BLOCKS = 8
const MARKDOWN_PARSE_BATCH_BYTES = 2 * 1024 * 1024

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

async function code(
  text: string,
  language: string | undefined,
  key: string,
  complete = false,
  priority: MarkdownWorkPriority = "visible",
) {
  if (isMermaidLanguage(language)) {
    return {
      language: "mermaid",
      generation: 0,
      stable: complete ? ([[text, ""]] as MarkdownToken[]) : [],
      unstable: complete ? [] : ([[text, ""]] as MarkdownToken[]),
    }
  }
  try {
    const result = await highlightStreamingCode(key, text, language ?? "text", complete, priority)
    return {
      language: result.language,
      generation: result.generation,
      stable: result.stable,
      unstable: result.unstable,
    }
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)
    return { language: language ?? "text", generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  state.dispose = dispose
  copyButtonState.set(host, state as CopyButtonState)
  return host
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <TooltipV2 placement="top" value={label()}>
      <IconButtonV2
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <IconV2 name="outline-copy" data-copy-icon />
            <IconV2 name="check" data-check-icon />
          </>
        }
      />
    </TooltipV2>
  )
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)
  if (copied) {
    host.setAttribute("data-copied", "true")
    return
  }
  host.removeAttribute("data-copied")
}

function disposeCopyButton(host: HTMLElement) {
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeCopyButton)
}

const shellLanguages = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

function codeKind(language: string | undefined) {
  const value = language?.toLowerCase()
  if (!value) return
  if (shellLanguages.has(value)) return "shell"
}

function codeLanguage(block: HTMLPreElement) {
  const code = block.querySelector("code")
  if (!(code instanceof HTMLElement)) return
  return code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

function applyCodeMetadata(wrapper: HTMLElement, language: string | undefined) {
  if (!document.body.hasAttribute("data-new-layout")) {
    delete wrapper.dataset.language
    delete wrapper.dataset.codeKind
    return
  }

  if (language) wrapper.dataset.language = language
  else delete wrapper.dataset.language

  const kind = codeKind(language)
  if (kind) wrapper.dataset.codeKind = kind
  else delete wrapper.dataset.codeKind
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    applyCodeMetadata(wrapper, codeLanguage(block))
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  applyCodeMetadata(parent, codeLanguage(block))

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    disposeCopyButton(button)
    button.remove()
  }
}

function decorateInlineCode(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    if (!(code instanceof HTMLElement)) continue
    const text = code.textContent ?? ""
    delete code.dataset.inlineCodeKind
    const kind = inlineCodeKind(text)
    if (kind) code.dataset.inlineCodeKind = kind

    const href = codeUrl(text)
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

let newLayout: boolean | undefined

function decorate(root: HTMLDivElement, labels: CopyLabels, live = false) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    if (isMermaidLanguage(codeLanguage(block)) && !live) continue
    ensureCodeWrapper(block, labels)
  }
  if (live) return
  if (newLayout === undefined) newLayout = document.body.hasAttribute("data-new-layout")
  if (!newLayout) return
  // Path classification and URL decoration walk the same inline-code nodes.
  // Keep them in one DOM traversal and read textContent once per node.
  decorateInlineCode(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
  if (!(button instanceof HTMLElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code instanceof HTMLElement ? renderedCodeSource.get(code) ?? code.textContent ?? "" : ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
    disposeCopyButtons(root)
  }
}

function initialResult(text: string, key: string | undefined, projection: Projection, owner: string): RenderResult {
  if (!text) return { text, cacheKey: key, blocks: [], changedFrom: 0 }
  const base = key ?? checksum(text)
  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = getCachedMarkdown(cacheKey)
      if (cached?.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })
    if (blocks.length === projection.blocks.length) return { text, cacheKey: key, blocks, changedFrom: 0 }
  }
  return {
    text,
    cacheKey: key,
    changedFrom: 0,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

function pendingProjection(text: string): Projection {
  return { text, blocks: text ? [{ raw: text, src: text, mode: "live" }] : [] }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [visible, setVisible] = createSignal(false)
  const [domCapacityTick, setDomCapacityTick] = createSignal(0)
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  const completedCode = new Map<string, Extract<RenderedBlock, { mode: "code" }>>()
  const COMPLETED_CODE_MAX = 200
  const COMPLETED_CODE_BYTES = 8 * 1024 * 1024
  const completedCodeSizes = new Map<string, number>()
  const activeDomKeys = new Set<string>()
  let completedCodeBytes = 0
  let domCapacityCleanup: (() => void) | undefined
  let markdownWorkActive = false
  createEffect(() => {
    const element = root()
    if (!element) return
    setVisible(false)
    onCleanup(observeMarkdownVisibility(element, setVisible))
  })
  const domPriority = (): MarkdownWorkPriority => {
    if (!visible()) return "background"
    return local.streaming ? "tail" : "visible"
  }
  const workPriority = (): MarkdownWorkPriority => {
    const priority = domPriority()
    // Large completed bodies first commit a safe text projection to the
    // selected surface. Their expensive rich parse stays on the background
    // lane so it cannot occupy the shared selected/tail lane for megabytes.
    if (priority === "visible" && local.text.length * 2 > MARKDOWN_CRITICAL_WORK_MAX_BYTES) return "background"
    return priority
  }
  const codeBytes = (value: Extract<RenderedBlock, { mode: "code" }>) => {
    let total = (value.raw.length + value.src.length + value.language.length) * 2
    for (const token of value.stable) total += token[0].length * 2 + token[1].length * 2
    for (const token of value.unstable) total += token[0].length * 2 + token[1].length * 2
    return total
  }
  const cacheCompletedCode = (key: string, value: Extract<RenderedBlock, { mode: "code" }>) => {
    const size = codeBytes(value)
    const previous = completedCodeSizes.get(key)
    if (previous !== undefined) completedCodeBytes -= previous
    completedCode.delete(key)
    completedCodeSizes.delete(key)
    if (size > COMPLETED_CODE_BYTES) return
    completedCode.set(key, value)
    completedCodeSizes.set(key, size)
    completedCodeBytes += size
    while (completedCode.size > COMPLETED_CODE_MAX || completedCodeBytes > COMPLETED_CODE_BYTES) {
      const oldest = completedCode.keys().next().value
      if (oldest === undefined) break
      completedCode.delete(oldest)
      completedCodeBytes -= completedCodeSizes.get(oldest) ?? 0
      completedCodeSizes.delete(oldest)
    }
  }
  let htmlGeneration = 0
  const [projection] = createResource(
    () => {
      if (isServer) return
      if (!visible()) return
      const live = local.streaming ?? false
      return { key: owner, text: local.text, live, priority: workPriority() }
    },
    (src) =>
      projectMarkdown(src.key, src.text, src.live, src.priority).catch((error) => {
        // Component cleanup cancels in-flight worker requests. Do not turn that
        // expected cancellation into an unhandled createResource rejection.
        if (error instanceof MarkdownWorkerDisposedError || error instanceof MarkdownWorkerSupersededError)
          return pendingProjection(src.text)
        // The worker is optional presentation work. If it is unavailable,
        // retain complete source text and let the bounded DOM path show it.
        return { text: src.text, blocks: src.text ? [{ raw: src.text, src: src.text, mode: "live" }] : [] } satisfies Projection
      }),
    { initialValue: pendingProjection("") },
  )
  const currentProjection = () => {
    const value = projection.latest
    if (value?.text === local.text) return value
    if (value?.text) return value
    return pendingProjection(local.text)
  }
  const [html] = createResource(
    () => {
      if (isServer)
        return {
          text: local.text,
          key: local.cacheKey,
          projection: pendingProjection(local.text),
          priority: workPriority(),
        }
      if (!visible()) return
      const value = projection.latest
      if (!value || value.text !== local.text) return
      return {
        text: local.text,
        key: local.cacheKey,
        projection: value,
        priority: workPriority(),
      }
    },
    async (src, info) => {
      if (isServer)
        return {
          text: src.text,
          cacheKey: src.key,
          changedFrom: 0,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, cacheKey: src.key, blocks: [], changedFrom: 0 } satisfies RenderResult
      const generation = ++htmlGeneration

      // stream() freezes every completed top-level block. Only the tail can be
      // live, so a full-array `.some()` on every token is unnecessary.
      const hasLiveBlock = src.projection.blocks.at(-1)?.mode === "live"
      // A live message changes on every token. Avoid hashing its entire
      // accumulated text and avoid populating the durable HTML cache with a
      // value that will be invalidated on the next token.
      const oversizedSource = src.text.length * 2 > MARKDOWN_CRITICAL_WORK_MAX_BYTES
      const base = src.key ?? (hasLiveBlock || oversizedSource ? undefined : checksum(src.text))
      const change = (src.projection as HostMarkdownProjection).change
      const previous = info.value as RenderResult | undefined
      const canReusePrefix =
        !!change &&
        !!previous &&
        previous.text === change.fromText &&
        previous.cacheKey === src.key &&
        change.keep <= previous.blocks.length &&
        change.keep <= src.projection.blocks.length
      const changedFrom = canReusePrefix ? change!.keep : 0
      const prefix = canReusePrefix ? previous!.blocks.slice(0, changedFrom) : []
      const suffix = src.projection.blocks.slice(changedFrom)
      const renderBlock = async (block: Block, index: number): Promise<RenderedBlock> => {
        const oversizedBlock = Math.max(block.raw.length, block.src.length) * 2 > MARKDOWN_RICH_BLOCK_MAX_BYTES
        const key = base && !oversizedBlock ? `${base}:${index}:${block.mode}` : undefined
        const blockKey = markdownBlockKey(owner, src.key, index, block.mode)
        registerMarkdownOwnerKey(owner, blockKey)
        if (oversizedBlock) {
          if (block.mode === "code")
            return {
              key: blockKey,
              mode: "full",
              raw: block.raw,
              hash: "oversized-code",
              html: "",
              plainText: block.src,
              plainCode: true,
            }
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: "", plainText: block.raw }
        }
        if (block.mode === "code") {
          const cached = completedCode.get(blockKey)
          if (block.complete && cached?.raw === block.raw) {
            completedCode.delete(blockKey)
            completedCode.set(blockKey, cached)
            return cached
          }
          const work = markdownBlockPriority(block, src.priority)
          const result = await code(block.src, block.language, blockKey, block.complete, work)
          const rendered = {
            key: blockKey,
            mode: block.mode,
            raw: block.raw,
            src: block.src,
            hash: String(block.raw.length),
            complete: !!block.complete,
            ...result,
          }
          if (block.complete) cacheCompletedCode(blockKey, rendered)
          return rendered
        }
        if (key) {
          const cached = getCachedMarkdown(key)
          if (cached?.raw === block.raw) {
            touchCachedMarkdown(key, cached)
            return { key: blockKey, mode: block.mode, ...cached }
          }
        }
        const hash = block.mode === "live" ? String(block.raw.length) : checksum(block.raw)
        const work = markdownBlockPriority(block, src.priority)
        let frameReservation: MarkdownFrameWorkReservation | undefined
        try {
          frameReservation = await reserveMarkdownFrameWork({
            key: blockKey,
            bytes: MARKDOWN_FRAME_WORK_MAX_JOB_BYTES,
            current: () => generation === htmlGeneration && visible(),
          })
          const parsed = await parseMarkdown(block.src, blockKey, work)
          if (generation !== htmlGeneration || !visible()) throw new MarkdownWorkerSupersededError()
          if (parsed.length * 2 > MARKDOWN_RICH_HTML_MAX_BYTES) throw new Error("Markdown HTML output exceeded the block limit")
          const sanitizeStarted = markdownTraceEnabled() ? performance.now() : 0
          const safe = await runMarkdownFrameWork({
            key: blockKey,
            priority: work,
            bytes: parsed.length * 2,
            current: () => generation === htmlGeneration && visible(),
            run: () => sanitizeMarkdown(parsed),
          }, frameReservation)
          frameReservation = undefined
          if (safe.length * 2 > MARKDOWN_RICH_HTML_MAX_BYTES) throw new Error("Sanitized Markdown HTML exceeded the block limit")
          if (sanitizeStarted !== 0)
            traceMarkdown({ phase: "sanitize", ms: performance.now() - sanitizeStarted, chars: block.src.length, htmlChars: parsed.length })
          if (key && hash && block.mode !== "live") touchCachedMarkdown(key, { raw: block.raw, hash, html: safe })
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: hash ?? "", html: safe }
        } catch (error) {
          if (
            error instanceof MarkdownWorkerDisposedError ||
            error instanceof MarkdownWorkerSupersededError ||
            (error instanceof DOMException && error.name === "AbortError")
          ) throw new MarkdownWorkerSupersededError()
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: "", plainText: block.raw }
        } finally {
          if (frameReservation) releaseMarkdownFrameWorkReservation(frameReservation)
        }
      }

      const rendered: RenderedBlock[] = [...prefix]
      let cursor = 0
      while (cursor < suffix.length) {
        if (generation !== htmlGeneration || !visible()) break
        let batchBytes = 0
        const batch: Array<{ block: Block; index: number }> = []
        while (cursor < suffix.length && batch.length < MARKDOWN_PARSE_BATCH_BLOCKS) {
          const block = suffix[cursor]!
          const bytes = Math.min(MARKDOWN_RICH_BLOCK_MAX_BYTES, Math.max(block.raw.length, block.src.length) * 2)
          if (batch.length && batchBytes + bytes > MARKDOWN_PARSE_BATCH_BYTES) break
          batch.push({ block, index: changedFrom + cursor })
          batchBytes += bytes
          cursor++
        }
        rendered.push(...(await Promise.all(batch.map(({ block, index }) => renderBlock(block, index)))))
        if (cursor < suffix.length) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      return {
        text: src.text,
        cacheKey: src.key,
        changedFrom,
        blocks: rendered,
      } satisfies RenderResult
    },
    {
      // SSR keeps its complete synchronous output. A browser mount starts with
      // an empty result so no checksum, fallback escaping, projection, or DOM
      // parse runs before the shared visibility owner admits this consumer.
      initialValue: isServer
        ? initialResult(
            local.text,
            local.cacheKey,
            local.streaming ? pendingProjection(local.text) : completedProjection(local.text),
            owner,
          )
        : { text: "", cacheKey: local.cacheKey, blocks: [], changedFrom: 0 },
    },
  )

  let copyCleanup: (() => void) | undefined
  let previousBlocks: RenderedBlock[] = []
  let requestedBlocks: RenderedBlock[] = []
  let previousCopyLabels: CopyLabels | undefined

  createEffect(() => {
    domCapacityTick()
    const tracing = markdownTraceEnabled()
    const effectStarted = tracing ? performance.now() : 0
    const container = root()
    if (!container) return
    if (isServer) return
    if (!visible()) {
      if (markdownWorkActive) {
        markdownWorkActive = false
        htmlGeneration++
        disposeMarkdownProjection(owner)
        cancelMarkdownFrameWork(owner)
        activeCodeKeys.clear()
      }
      // Retain a rendered tree when it scrolls away. A cold hidden mount gets
      // only a bounded, explicit placeholder box; it does not touch message
      // bytes or create per-row work while waiting for activation.
      if (!container.dataset.markdownReady && !container.firstElementChild) {
        const placeholder = document.createElement("div")
        placeholder.dataset.markdownPlaceholder = ""
        placeholder.setAttribute("aria-hidden", "true")
        placeholder.style.blockSize = `${Math.min(320, Math.max(96, Math.ceil(local.text.length / 120) * 24))}px`
        container.appendChild(placeholder)
      }
      if (activeDomKeys.size) {
        requestedBlocks = []
        for (const child of Array.from(container.children)) {
          if (!(child instanceof HTMLElement) || !activeDomKeys.has(child.dataset.markdownKey ?? "")) continue
          const key = child.dataset.markdownKey!
          cancelMarkdownDomCommit(key)
          activeDomKeys.delete(key)
          const code = child.querySelector("code")
          if (code instanceof HTMLElement) renderedCodeSource.delete(code)
          child.replaceChildren()
          child.removeAttribute("data-markdown-hash")
          child.removeAttribute("data-markdown-pending")
          renderedCodeTokens.delete(child as HTMLDivElement)
        }
        previousBlocks = []
      }
      return
    }
    markdownWorkActive = true
    resumeMarkdownDomCommit()
    resumeMarkdownFrameWork()
    container.dataset.markdownReady = "true"
    container.querySelector("[data-markdown-placeholder]")?.remove()
    const result = (html.latest ?? html()) as RenderResult | undefined
    const projected = currentProjection()
    const pending = local.text
      ? pendingBlocks(result, projected, local.cacheKey, owner)
      : { blocks: [] as RenderedBlock[], changedFrom: 0 }
    const content = pending.blocks
    requestedBlocks = content
    if (content.length === 0) {
      requestedBlocks = []
      activeCodeKeys.forEach(disposeCode)
      activeCodeKeys.clear()
      previousBlocks = []
      disposeCopyButtons(container)
      disposeMermaidBlocks(container)
      container.innerHTML = ""
      activeDomKeys.forEach(cancelMarkdownDomCommit)
      activeDomKeys.clear()
      if (tracing)
        traceMarkdown({
          phase: "effect",
          ms: performance.now() - effectStarted,
          textChars: local.text.length,
          blockCount: 0,
          streaming: local.streaming ?? false,
        })
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    // Worker projection patches tell us the exact first changed block. Trust
    // that seam only when our retained DOM/result prefix is long enough;
    // otherwise recover conservatively with a full reconciliation.
    let changedFrom = pending.changedFrom
    if (changedFrom > previousBlocks.length || changedFrom > container.children.length) changedFrom = 0
    const changedEnd = Math.max(previousBlocks.length, content.length)
    for (let index = changedFrom; index < changedEnd; index++) {
      const before = previousBlocks[index]
      const after = content[index]
      if (before?.mode === "code" && (after?.mode !== "code" || after.key !== before.key)) {
        activeCodeKeys.delete(before.key)
        disposeCode(before.key)
      }
      if (after?.mode === "code") activeCodeKeys.add(after.key)
    }
    // Projection keeps completed/pending blocks referentially stable. Updating
    // every historical markdown block on each paced live token still performs
    // DOM child lookup, mode dispatch, code-token bookkeeping, and (for code)
    // querySelector work. Touch only blocks whose rendered object changed.
    let domBackpressured = false
    for (let index = changedFrom; index < content.length; index++) {
      const block = content[index]!
      if (previousBlocks[index] === block && container.children[index]) continue
      const committed = updateBlock(container, index, block, labels, tracing, domPriority(), {
        activeDomKeys,
        isCurrent: () => requestedBlocks[index] === block,
      })
      if (!committed) {
        domCapacityCleanup ??= subscribeMarkdownDomCapacity(() => {
          domCapacityCleanup?.()
          domCapacityCleanup = undefined
          setDomCapacityTick((value) => value + 1)
        })
        previousBlocks = content.slice(0, index)
        domBackpressured = true
        break
      }
    }
    while (container.children.length > content.length) {
      const child = container.lastElementChild
      if (!child) break
      if (child instanceof HTMLElement && child.dataset.markdownKey) {
        cancelMarkdownDomCommit(child.dataset.markdownKey)
        activeDomKeys.delete(child.dataset.markdownKey)
      }
      disposeCopyButtons(child)
      disposeMermaidBlocks(child)
      child.remove()
    }
    if (!domBackpressured) {
      if (changedFrom === 0) previousBlocks = content.slice()
      else {
        previousBlocks.length = changedFrom
        for (let index = changedFrom; index < content.length; index++) previousBlocks.push(content[index]!)
      }
    }
    // New copy controls receive current labels when their block is decorated.
    // Existing controls only need a tree-wide update when locale labels change,
    // not every streaming markdown render.
    if (
      previousCopyLabels &&
      (previousCopyLabels.copy !== labels.copy || previousCopyLabels.copied !== labels.copied)
    ) {
      container
        .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
        .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    }
    previousCopyLabels = labels
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    if (tracing)
      traceMarkdown({
        phase: "effect",
        ms: performance.now() - effectStarted,
        textChars: local.text.length,
        blockCount: content.length,
        streaming: local.streaming ?? false,
      })
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    const container = root()
    if (container) disposeMermaidBlocks(container)
    disposeMarkdownProjection(owner)
    cancelMarkdownFrameWork(owner)
    activeDomKeys.forEach(cancelMarkdownDomCommit)
    activeDomKeys.clear()
    domCapacityCleanup?.()
    domCapacityCleanup = undefined
    activeCodeKeys.forEach(disposeCode)
    completedCode.clear()
    completedCodeSizes.clear()
    completedCodeBytes = 0
  })

  return (
    <div
      data-component="markdown"
      dir="auto"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return { blocks: [] as RenderedBlock[], changedFrom: 0 }
  if (!projection || result.text === projection.text)
    return { blocks: result.blocks, changedFrom: result.changedFrom }
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  const change = (projection as HostMarkdownProjection).change
  const canReusePrefix =
    !initial &&
    result.cacheKey === cacheKey &&
    change?.fromText === result.text &&
    change.keep <= result.blocks.length &&
    change.keep <= projection.blocks.length
  const changedFrom = canReusePrefix ? change!.keep : 0
  const blocks = canReusePrefix ? result.blocks.slice(0, changedFrom) : []
  for (let index = changedFrom; index < projection.blocks.length; index++) {
    const block = projection.blocks[index]!
    const current = initial ? undefined : result.blocks[index]
    if (current && canReusePendingBlock(current, block)) {
      blocks.push(current)
      continue
    }
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)
    if (block.mode !== "code") {
      blocks.push({ key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: "", plainText: block.src })
      continue
    }
    blocks.push({
      key,
      mode: block.mode,
      raw: block.raw,
      src: block.src,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    })
  }
  return { blocks, changedFrom }
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function markdownBlockPriority(block: Block, messagePriority: MarkdownWorkPriority): MarkdownWorkPriority {
  if (messagePriority === "background") return "background"
  if (block.mode === "live" || (block.mode === "code" && !block.complete)) return "tail"
  return "visible"
}

function updateBlock(
  container: HTMLDivElement,
  index: number,
  block: RenderedBlock,
  labels: CopyLabels,
  tracing: boolean,
  priority: MarkdownWorkPriority,
  state: { activeDomKeys: Set<string>; isCurrent: () => boolean },
): boolean {
  const started = tracing ? performance.now() : 0
  const current = container.children[index]
  if (block.mode !== "code" && block.plainCode) return updatePlainCodeBlock(container, current, block, labels, priority, state)
  if (block.mode === "code") {
    if (block.complete && isMermaidLanguage(block.language)) {
      updateMermaidBlock(container, current, block, labels, tracing, started)
      return true
    }
    return updateCodeBlock(container, current, block, labels, tracing, started, priority, state)
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  ) {
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "skip",
        mode: block.mode,
        chars: block.raw.length,
        htmlChars: block.html.length,
      })
    return true
  }

  if (block.plainText !== undefined && block.plainText.length >= MARKDOWN_DOM_COOPERATIVE_THRESHOLD) {
    const bytes = Math.min(block.plainText.length * 2, 1024 * 1024)
    if (!canCommitMarkdownDom(bytes)) return false
    const next = document.createElement("div")
    next.dataset.markdownBlock = ""
    next.dataset.markdownKey = block.key
    next.dataset.markdownHash = block.hash
    next.dataset.markdownPending = "true"
    next.style.display = "contents"
    if (current instanceof HTMLDivElement) {
      disposeCopyButtons(current)
      disposeMermaidBlocks(current)
      current.replaceWith(next)
    } else {
      container.appendChild(next)
    }
    state.activeDomKeys.add(block.key)
    if (!commitMarkdownDom({
      key: block.key,
      html: "",
      plainText: block.plainText,
      parent: container,
      wrapper: next,
      priority,
      isCurrent: () => state.isCurrent() && container.children[index] === next,
      complete: () => state.activeDomKeys.delete(block.key),
    })) return false
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "cooperative-text-commit",
        mode: block.mode,
        chars: block.plainText.length,
        htmlChars: 0,
      })
    return true
  }

  if (block.html.length >= MARKDOWN_DOM_COOPERATIVE_THRESHOLD) {
    if (!canCommitMarkdownDom(block.html.length * 2)) return false
    const next = document.createElement("div")
    next.dataset.markdownBlock = ""
    next.dataset.markdownKey = block.key
    next.dataset.markdownHash = block.hash
    next.dataset.markdownPending = "true"
    next.style.display = "contents"
    if (current instanceof HTMLDivElement) {
      disposeCopyButtons(current)
      disposeMermaidBlocks(current)
      current.replaceWith(next)
    } else {
      container.appendChild(next)
    }
    state.activeDomKeys.add(block.key)
    if (!commitMarkdownDom({
      key: block.key,
      html: block.html,
      parent: container,
      wrapper: next,
      priority,
      isCurrent: () => state.isCurrent() && container.children[index] === next,
      complete: () => {
        state.activeDomKeys.delete(block.key)
        decorate(next, labels, block.mode === "live")
        if (block.mode !== "live") hydrateMermaidBlocks(next, labels)
      },
    })) return false
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "cooperative-commit",
        mode: block.mode,
        chars: block.raw.length,
        htmlChars: block.html.length,
      })
    return true
  }

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  const innerHTMLStarted = tracing ? performance.now() : 0
  if (block.plainText !== undefined) {
    next.style.whiteSpace = "pre-line"
    next.textContent = block.plainText
  } else {
    next.innerHTML = block.html
  }
  const innerHTMLMs = tracing ? performance.now() - innerHTMLStarted : undefined
  const decorateStarted = tracing ? performance.now() : 0
  decorate(next, labels, block.mode === "live")
  const decorateMs = tracing ? performance.now() - decorateStarted : undefined

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    if (block.mode !== "live") hydrateMermaidBlocks(next, labels)
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "append",
        mode: block.mode,
        chars: block.raw.length,
        htmlChars: block.html.length,
        innerHTMLMs,
        decorateMs,
      })
    return true
  }

  const morphStarted = tracing ? performance.now() : 0
  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLElement &&
        toEl instanceof HTMLElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onBeforeNodeDiscarded: (node) => {
      if (node instanceof Element) {
        disposeCopyButtons(node)
        disposeMermaidBlocks(node)
      }
      return true
    },
  })
  if (block.mode !== "live") hydrateMermaidBlocks(current, labels)
  if (tracing)
    traceMarkdown({
      phase: "block",
      ms: performance.now() - started,
      action: "morph",
      mode: block.mode,
      chars: block.raw.length,
      htmlChars: block.html.length,
      innerHTMLMs,
      decorateMs,
      morphMs: performance.now() - morphStarted,
    })
  return true
}

function updatePlainCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { plainCode?: boolean }>,
  labels: CopyLabels,
  priority: MarkdownWorkPriority,
  state: { activeDomKeys: Set<string>; isCurrent: () => boolean },
): boolean {
  const source = block.plainText ?? ""
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const existingCode = existing?.querySelector("code")
  if (existingCode instanceof HTMLElement && renderedCodeSource.get(existingCode) === source) return true
  const bytes = Math.min(source.length * 2, 1024 * 1024)
  if (!canCommitMarkdownDom(bytes)) return false
  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownPending = "true"
  next.dataset.markdownPlainCode = "true"
  next.style.display = "contents"
  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, "text")
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const code = document.createElement("code")
  code.className = "language-text"
  renderedCodeSource.set(code, source)
  pre.appendChild(code)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
  } else container.appendChild(next)
  state.activeDomKeys.add(block.key)
  const committed = commitMarkdownDom({
    key: block.key,
    html: "",
    plainText: source,
    bytes,
    target: code,
    parent: container,
    wrapper: next,
    priority,
    isCurrent: () => state.isCurrent() && next.parentElement === container,
    complete: () => state.activeDomKeys.delete(block.key),
  })
  if (!committed) {
    state.activeDomKeys.delete(block.key)
    next.remove()
    return false
  }
  return true
}

function updateMermaidBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
  tracing: boolean,
  started: number,
) {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = "true"
  next.style.display = "contents"
  renderedCodeTokens.delete(next)

  if (existing) {
    disposeCopyButtons(next)
    mountMermaidBlock(next, block.src, labels)
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "mermaid-update",
        mode: block.mode,
        chars: block.raw.length,
      })
    return
  }

  if (current) {
    disposeCopyButtons(current)
    disposeMermaidBlocks(current)
    current.replaceWith(next)
  } else {
    container.appendChild(next)
  }
  mountMermaidBlock(next, block.src, labels)
  if (tracing)
    traceMarkdown({
      phase: "block",
      ms: performance.now() - started,
      action: "mermaid-mount",
      mode: block.mode,
      chars: block.raw.length,
    })
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
  tracing: boolean,
  started: number,
  priority: MarkdownWorkPriority,
  state: { activeDomKeys: Set<string>; isCurrent: () => boolean },
): boolean {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  const existingCode = existing?.querySelector("code")
  if (existing?.dataset.markdownPlainCode === "true" && existingCode instanceof HTMLElement) {
    if (renderedCodeSource.get(existingCode) === block.src) return true
    if (existing.dataset.markdownPending === "true") {
      cancelMarkdownDomCommit(block.key)
      state.activeDomKeys.delete(block.key)
    }
    existingCode.replaceChildren()
    renderedCodeSource.delete(existingCode)
    renderedCodeTokens.delete(existing)
    existing.removeAttribute("data-markdown-plain-code")
    existing.removeAttribute("data-markdown-pending")
    existing.removeAttribute("data-markdown-hash")
  }
  if (existing?.dataset.markdownPending === "true") {
    const previous = renderedCodeTokens.get(existing)
    if (
      previous?.raw === block.raw &&
      previous.language === block.language &&
      previous.generation === block.generation
    ) return true
    const pendingCode = existing.querySelector("code")
    cancelMarkdownDomCommit(block.key)
    state.activeDomKeys.delete(block.key)
    if (pendingCode instanceof HTMLElement) {
      pendingCode.replaceChildren()
      renderedCodeSource.delete(pendingCode)
    }
    renderedCodeTokens.delete(existing)
    existing.removeAttribute("data-markdown-pending")
    existing.removeAttribute("data-markdown-hash")
    return updateCodeBlock(container, existing, block, labels, tracing, started, priority, state)
  }
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")
  if (existing && code instanceof HTMLElement) {
    const wrapper = code.closest('[data-component="markdown-code"]')
    if (wrapper instanceof HTMLElement) applyCodeMetadata(wrapper, block.language)
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    const append = tail.slice(keep - stableCount)
    const appendChars = Math.max(0, block.raw.length - (reset ? 0 : previous?.raw.length ?? 0))
    const estimatedBytes =
      append.length > 4096
        ? 1024 * 1024 + 1
        : append.reduce((total, token) => total + token[1].length * 2 + 64, appendChars * 2)
    if ((appendChars >= MARKDOWN_DOM_COOPERATIVE_THRESHOLD || append.length > 128) && append.length > 0) {
      const codeBytes = Math.min(block.raw.length * 2, 1024 * 1024)
      const plainFallback = estimatedBytes > 1024 * 1024
      if (!canCommitMarkdownDom(plainFallback ? codeBytes : estimatedBytes)) return false
      if (plainFallback) code.replaceChildren()
      else while (code.children.length > keep) code.lastElementChild?.remove()
      const wrapper = code.closest('[data-component="markdown-code"]')
      if (wrapper instanceof HTMLElement) renderedCodeSource.set(code, block.src)
      existing.dataset.markdownHash = block.hash
      existing.dataset.markdownPending = "true"
      if (plainFallback) existing.dataset.markdownPlainCode = "true"
      state.activeDomKeys.add(block.key)
      const committed = commitMarkdownDom({
        key: block.key,
        html: "",
        ...(plainFallback ? { plainText: block.src } : { tokens: append }),
        bytes: plainFallback ? codeBytes : estimatedBytes,
        tokenSpan: createTokenSpan,
        target: code,
        parent: container,
        wrapper: next,
        priority,
        isCurrent: () => state.isCurrent() && next.parentElement === container,
        complete: () => state.activeDomKeys.delete(block.key),
      })
      if (!committed) {
        state.activeDomKeys.delete(block.key)
        existing.removeAttribute("data-markdown-pending")
        if (plainFallback) existing.removeAttribute("data-markdown-plain-code")
        return false
      }
      if (!plainFallback)
        renderedCodeTokens.set(next, {
          language: block.language,
          generation: block.generation,
          stableCount: block.stable.length,
          unstable: block.unstable,
          raw: block.raw,
        })
      if (tracing)
        traceMarkdown({
          phase: "block",
          ms: performance.now() - started,
          action: "cooperative-code-append",
          mode: block.mode,
          chars: appendChars,
          tokenCount: append.length,
        })
      return true
    }
    while (code.children.length > keep) code.lastElementChild?.remove()
    const codeStarted = tracing ? performance.now() : 0
    append.map(createTokenSpan).forEach((span) => code.appendChild(span))
    if (tracing)
      traceMarkdown({
        phase: "block",
        ms: performance.now() - started,
        action: "code-update",
        mode: block.mode,
        chars: block.raw.length,
        codeMs: performance.now() - codeStarted,
        tokenCount: tail.length - (keep - stableCount),
      })
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    renderedCodeSource.set(code, block.src)
    return true
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, block.language)
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  const tokens = [...block.stable, ...block.unstable]
  const tokenBytes =
    tokens.length > 4096
      ? 1024 * 1024 + 1
      : tokens.reduce((total, token) => total + token[1].length * 2 + 64, block.raw.length * 2)
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeSource.set(codeElement, block.src)
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
  } else container.appendChild(next)
  if ((block.raw.length >= MARKDOWN_DOM_COOPERATIVE_THRESHOLD || tokens.length > 128) && tokens.length > 0) {
    if (!canCommitMarkdownDom(tokenBytes)) {
      const codeBytes = Math.min(block.raw.length * 2, 1024 * 1024)
      if (!canCommitMarkdownDom(codeBytes)) return false
      next.dataset.markdownPlainCode = "true"
      next.dataset.markdownPending = "true"
      state.activeDomKeys.add(block.key)
      const committed = commitMarkdownDom({
        key: block.key,
        html: "",
        plainText: block.src,
        bytes: codeBytes,
        target: codeElement,
        parent: container,
        wrapper: next,
        priority,
        isCurrent: () => state.isCurrent() && next.parentElement === container,
        complete: () => state.activeDomKeys.delete(block.key),
      })
      if (!committed) {
        state.activeDomKeys.delete(block.key)
        next.remove()
        return false
      }
      renderedCodeTokens.delete(next)
      return true
    }
    next.dataset.markdownPending = "true"
    state.activeDomKeys.add(block.key)
    const committed = commitMarkdownDom({
      key: block.key,
      html: "",
      tokens,
      bytes: tokenBytes,
      tokenSpan: createTokenSpan,
      target: codeElement,
      parent: container,
      wrapper: next,
      priority,
      isCurrent: () => state.isCurrent() && next.parentElement === container,
      complete: () => state.activeDomKeys.delete(block.key),
    })
    if (!committed) {
      state.activeDomKeys.delete(block.key)
      next.remove()
      return false
    }
    if (tracing)
      traceMarkdown({ phase: "block", ms: performance.now() - started, action: "cooperative-code-mount", mode: block.mode, chars: block.raw.length, tokenCount: tokens.length })
    return true
  }
  tokens.map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (tracing)
    traceMarkdown({
      phase: "block",
      ms: performance.now() - started,
      action: "code-mount",
      mode: block.mode,
      chars: block.raw.length,
      codeMs: performance.now() - started,
      tokenCount: block.stable.length + block.unstable.length,
    })
  return true
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

// Shiki reuses a small vocabulary of declarations. Parsing the same inline
// style string for every token makes Blink do redundant CSS work and inflates
// the DOM payload. Intern the vocabulary once per renderer and attach a class
// backed by one bounded stylesheet; unusual/overflow styles retain the safe
// inline fallback.
const TOKEN_STYLE_LIMIT = 256
const tokenStyleClasses = new Map<string, string>()
let tokenStyleSheet: HTMLStyleElement | undefined
function internTokenStyle(style: string) {
  if (!style || typeof document === "undefined") return
  const cached = tokenStyleClasses.get(style)
  if (cached) return cached
  if (tokenStyleClasses.size >= TOKEN_STYLE_LIMIT) return
  const className = `oc-md-token-${tokenStyleClasses.size}`
  tokenStyleClasses.set(style, className)
  tokenStyleSheet ??= (() => {
    const element = document.createElement("style")
    element.dataset.markdownTokenStyles = ""
    document.head.appendChild(element)
    return element
  })()
  tokenStyleSheet.append(document.createTextNode(`.${className}{${style}}`))
  return className
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  const className = internTokenStyle(token[1])
  if (className) span.className = className
  else if (token[1]) span.style.cssText = token[1]
  span.textContent = token[0]
  return span
}
