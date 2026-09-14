/// <reference lib="webworker" />

import { ShikiStreamTokenizer } from "@shikijs/stream"
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked-theme"
import type { TokensList } from "marked"
import {
  bundledLanguages,
  createHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledLanguage,
  type ThemedToken,
} from "shiki"
import {
  diffMarkdownProjection,
  type MarkdownParseRequest,
  type MarkdownProjectRequest,
  type MarkdownToken,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "./markdown-worker-protocol"
import { createLatestWorkerQueue } from "./markdown-worker-queue"
import { appendPlainMarkdownTokens } from "./markdown-incremental-tokens"
import { project, type Projection } from "./markdown-stream"

type Stream = {
  language: string
  sourceLength: number
  tokenizer: ShikiStreamTokenizer
}

const streams = new Map<string, Stream>()
const streamSizes = new Map<string, number>()
let streamBytesTotal = 0
const projections = new Map<string, Projection>()
const projectionSizes = new Map<string, number>()
let projectionBytesTotal = 0
const MAX_PROJECTIONS = 512
// The host runs two stable-affinity workers to eliminate cross-session parse
// head-of-line blocking. Keep the aggregate cache budget near the former
// singleton total instead of doubling retained Markdown source/state merely
// because there are now two CPU lanes.
const MAX_PROJECTION_BYTES = 8 * 1024 * 1024
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_PARSE_STATE_BYTES = 8 * 1024 * 1024
const MAX_PARSE_STATES = 200
type ParseState = { text: string; tokens: TokensList }
const parseStates = new Map<string, ParseState>()
const parseStateSizes = new Map<string, number>()
let parseStateBytesTotal = 0
let highlighter: ReturnType<typeof createHighlighter> | undefined
const workerReceived = new Map<number, number>()
function disposeStream(key: string) {
  streams.delete(key)
  streamBytesTotal -= streamSizes.get(key) ?? 0
  streamSizes.delete(key)
}
function disposeProjection(key: string) {
  projections.delete(key)
  projectionBytesTotal -= projectionSizes.get(key) ?? 0
  projectionSizes.delete(key)
}
function disposeParseState(key: string) {
  parseStates.delete(key)
  parseStateBytesTotal -= parseStateSizes.get(key) ?? 0
  parseStateSizes.delete(key)
}
function retainParseState(key: string, state: ParseState) {
  disposeParseState(key)
  // Marked token trees retain raw/text slices in addition to the source. Use a
  // deliberately conservative multiplier so incremental parsing cannot turn
  // long-lived sessions into an unbounded worker-side AST cache.
  const size = state.text.length * 8
  if (size > MAX_PARSE_STATE_BYTES) return
  parseStates.set(key, state)
  parseStateSizes.set(key, size)
  parseStateBytesTotal += size
  while (parseStates.size > MAX_PARSE_STATES || parseStateBytesTotal > MAX_PARSE_STATE_BYTES) {
    const oldest = parseStates.keys().next().value
    if (oldest === undefined) break
    disposeParseState(oldest)
  }
}
const highlightQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  run: highlight,
  supersede: (request) => {
    workerReceived.delete(request.id)
    post({ type: "superseded", id: request.id, key: request.key })
  },
  dispose: disposeStream,
})
const projectQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  run: runProject,
  supersede: (request) => {
    workerReceived.delete(request.id)
    post({ type: "superseded", id: request.id, key: request.key })
  },
  dispose: disposeProjection,
})
const parseQueue = createLatestWorkerQueue<MarkdownParseRequest>({
  run: parse,
  supersede: (request) => {
    workerReceived.delete(request.id)
    post({ type: "superseded", id: request.id, key: request.key })
  },
  dispose: disposeParseState,
})
const parser = createMarkdownParser(async (code, language) => {
  const languageID = language.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (languageID === "mermaid" || languageID === "mmd") return plainCode(code, languageID)
  const instance = await getHighlighter()
  const name = language in bundledLanguages ? language : "text"
  if (!instance.getLoadedLanguages().includes(name))
    await instance.loadLanguage(bundledLanguages[name as BundledLanguage])
  return instance.codeToHtml(code, { lang: name as BundledLanguage, theme: "OpenCode", tabindex: false })
})

function plainCode(code: string, language: string) {
  const safe = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
  const lang = language.trim().split(/\s+/, 1)[0] || "mermaid"
  return `<pre class="shiki OpenCode"><code class="language-${lang}">${safe}</code></pre>`
}

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  if (event.data.type === "dispose") {
    highlightQueue.dispose(event.data.key)
    projectQueue.dispose(event.data.key)
    parseQueue.dispose(event.data.key)
    return
  }
  if (event.data.type === "parse") {
    workerReceived.set(event.data.id, performance.now())
    parseQueue.highlight(event.data)
    return
  }
  if (event.data.type === "project") {
    workerReceived.set(event.data.id, performance.now())
    projectQueue.highlight(event.data)
    return
  }

  workerReceived.set(event.data.id, performance.now())
  highlightQueue.highlight(event.data)
}

async function parse(request: MarkdownParseRequest) {
  const started = performance.now()
  const received = workerReceived.get(request.id) ?? started
  workerReceived.delete(request.id)
  const workerQueueMs = started - received
  try {
    const retained = "text" in request ? undefined : parseStates.get(request.key)
    const text =
      "text" in request
        ? request.text
        : retained?.text.length === request.baseLength
          ? retained.text + request.append
          : undefined
    if (text === undefined) {
      post({ type: "parse-miss", id: request.id, key: request.key })
      return
    }
    // The lexer dominates live Markdown CPU (~99% in the streaming benchmark).
    // For grammar-safe append-only text, update the retained terminal token path
    // and render those tokens directly. Structural/ambiguous suffixes fall back
    // to a normal configured lexer pass, so feature semantics remain identical.
    let tokens: TokensList
    const incremental =
      !("text" in request) &&
      !!retained &&
      appendPlainMarkdownTokens(retained.tokens, request.append, retained.text)
    if (incremental) {
      tokens = retained.tokens
    } else {
      tokens = parser.lexer(text)
    }
    const html = await parser.parser(tokens)
    retainParseState(request.key, { text, tokens })
    post({
      type: "parse",
      id: request.id,
      key: request.key,
      html,
      incremental,
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  } catch (error) {
    // Never reuse a token tree after a parser/renderer exception. The next
    // request will repair from the host's full source through parse-miss/reset.
    disposeParseState(request.key)
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  }
}

async function runProject(request: MarkdownProjectRequest) {
  const started = performance.now()
  const received = workerReceived.get(request.id) ?? started
  workerReceived.delete(request.id)
  const workerQueueMs = started - received
  try {
    const retained = "text" in request ? undefined : projections.get(request.key)
    const text =
      "text" in request
        ? request.text
        : retained?.text.length === request.baseLength
          ? retained.text + request.append
          : undefined
    if (text === undefined) {
      post({ type: "project-miss", id: request.id, key: request.key })
      return
    }
    const projection = project(retained, text, request.live)
    const patch = diffMarkdownProjection(retained, projection)
    const size = projection.text.length * 2 + projection.blocks.reduce((total, block) => total + block.raw.length * 2 + block.src.length * 2, 0)
    const previousSize = projectionSizes.get(request.key)
    if (previousSize !== undefined) {
      projectionSizes.delete(request.key)
      projectionBytesTotal -= previousSize
    }
    projections.delete(request.key)
    if (size <= MAX_PROJECTION_BYTES) {
      projections.set(request.key, projection)
      projectionSizes.set(request.key, size)
      projectionBytesTotal += size
    }
    while (projections.size > MAX_PROJECTIONS || projectionBytesTotal > MAX_PROJECTION_BYTES) {
      const oldest = projections.keys().next().value
      if (oldest === undefined) break
      projections.delete(oldest)
      projectionBytesTotal -= projectionSizes.get(oldest) ?? 0
      projectionSizes.delete(oldest)
    }
    post({
      type: "project",
      id: request.id,
      key: request.key,
      patch,
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  }
}

async function highlight(request: Extract<MarkdownWorkerRequest, { type: "highlight" }>) {
  const started = performance.now()
  const received = workerReceived.get(request.id) ?? started
  workerReceived.delete(request.id)
  const workerQueueMs = started - received
  try {
    const instance = await getHighlighter()
    const language = request.language in bundledLanguages ? request.language : "text"
    if (!instance.getLoadedLanguages().includes(language))
      await instance.loadLanguage(bundledLanguages[language as BundledLanguage])

    if (request.complete) {
      // Completion intentionally arrives as a full reset. The streaming path
      // retains tokenizer state but not the full source string, so this is the
      // one point where complete code is transferred/materialized for Shiki's
      // whole-document tokenization.
      const result = instance.codeToTokens(request.text, { lang: language as BundledLanguage, theme: "OpenCode" })
      disposeStream(request.key)
      post({
        type: "highlight",
        id: request.id,
        key: request.key,
        language,
        reset: true,
        stable: result.tokens
          .flatMap((line, index) =>
            index === result.tokens.length - 1 ? line : [...line, { content: "\n", offset: 0 }],
          )
          .map(token),
        unstable: [],
        workerMs: performance.now() - started,
        workerQueueMs,
      })
      return
    }

    const previous = streams.get(request.key)
    const reset = "text" in request
    if (
      !reset &&
      (!previous || previous.language !== language || previous.sourceLength !== request.baseLength)
    ) {
      post({ type: "highlight-miss", id: request.id, key: request.key })
      return
    }
    const stream = reset
      ? {
          language,
          sourceLength: 0,
          tokenizer: new ShikiStreamTokenizer({ highlighter: instance, lang: language, theme: "OpenCode" }),
        }
      : previous!
    const append = reset ? request.text : request.append
    const result = await stream.tokenizer.enqueue(append)
    stream.sourceLength += append.length
    disposeStream(request.key)
    const size = stream.sourceLength * 2
    if (size <= MAX_STREAM_BYTES) {
      streams.set(request.key, stream)
      streamSizes.set(request.key, size)
      streamBytesTotal += size
      while (streams.size > 200 || streamBytesTotal > MAX_STREAM_BYTES) {
        const oldest = streams.keys().next().value
        if (oldest === undefined) break
        disposeStream(oldest)
      }
    }
    post({
      type: "highlight",
      id: request.id,
      key: request.key,
      language,
      reset,
      stable: result.stable.filter((token) => token.content.length > 0).map(token),
      unstable: result.unstable.filter((token) => token.content.length > 0).map(token),
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
      workerMs: performance.now() - started,
      workerQueueMs,
    })
  }
}

function getHighlighter() {
  return (highlighter ??= createHighlighter({ themes: [OpenCodeTheme], langs: [] }))
}

function post(response: MarkdownWorkerResponse) {
  self.postMessage(response)
}

function token(value: ThemedToken): MarkdownToken {
  return [value.content, stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value))]
}
