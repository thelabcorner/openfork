// Ported from packages/session-ui/src/components/{markdown-stream,markdown-projection}.ts
//
// Splits streamed markdown text into blocks so a growing assistant message
// only re-parses its still-changing tail on each token delta — completed
// paragraphs/code fences keep their already-rendered HTML. This is the core
// perf win for long chats: without it, every delta would re-run marked+shiki
// over the entire message text.
import { marked, type Tokens } from "marked"
import remend from "remend"

export type BlockMode = "full" | "live" | "code"

export type Block = {
  raw: string
  src: string
  mode: BlockMode
  language?: string
  complete?: boolean
  appendSafe?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

export function completedProjection(text: string): Projection {
  return { text, blocks: [{ raw: text, src: text, mode: "full" }] }
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(stabilizePendingList(text) ?? text, { linkMode: "text-only" })
}

// Exact prefix proof without String#startsWith's eager growing-prefix walk.
// The streaming reducer produces concatenated strings, so engines can normally
// reuse substring/rope storage for this slice before equality comparison.
function hasTextPrefix(text: string, previous: string) {
  return text.length >= previous.length && text.slice(0, previous.length) === previous
}

const STREAM_LIST_SENTINEL = "\u200b"
const PENDING_BULLET_LINE = /^[ \t]*-[ \t]*$/

function containsStreamListSentinel(tokens: Tokens.Generic[]): boolean {
  for (const token of tokens) {
    if (token.type !== "list") continue
    const list = token as Tokens.List
    for (const item of list.items) {
      if (item.text === STREAM_LIST_SENTINEL) return true
      if (containsStreamListSentinel(item.tokens)) return true
    }
  }
  return false
}

function stabilizePendingList(text: string) {
  const newline = text.lastIndexOf("\n")
  if (newline < 0) return undefined
  const line = text.slice(newline + 1)
  if (!PENDING_BULLET_LINE.test(line)) return undefined
  const before = marked.lexer(text.slice(0, newline))
  const previous = before.findLast((token) => token.type !== "space")
  if (previous?.type !== "list") return undefined
  const candidate = `${text.replace(/[ \t]+$/, "")} ${STREAM_LIST_SENTINEL}`
  if (!containsStreamListSentinel(marked.lexer(candidate))) return undefined
  return candidate
}

const BLANK_LINE = /\r?\n[ \t]*\r?\n/
const BLANK_LINE_AT_END = /\r?\n[ \t]*\r?\n[ \t]*$/

function crossesBlankLine(raw: string, suffix: string) {
  // No newline in the newly appended bytes means no new blank-line boundary
  // can possibly have appeared. Avoid scanning the entire growing live tail on
  // the overwhelmingly common token path.
  if (!suffix.includes("\n") && !suffix.includes("\r")) return false
  if (BLANK_LINE.test(suffix)) return true
  if (BLANK_LINE_AT_END.test(raw)) return true
  const newline = raw.lastIndexOf("\n")
  if (newline < 0) return false
  return BLANK_LINE.test(raw.slice(newline) + suffix)
}

/** Re-lex only the mutable tail; frozen top-level blocks retain identity. */
function reprojectTail(previous: Projection, text: string, suffix: string): Projection {
  // Reference definitions can resolve earlier frozen blocks, so they are the
  // intentional whole-message escape hatch.
  if (suffix.includes("]:") && refs(text)) return { text, blocks: stream(text, true) }
  const tail = previous.blocks.at(-1)
  if (!tail) return { text, blocks: stream(text, true) }
  return {
    text,
    blocks: [...previous.blocks.slice(0, -1), ...stream(tail.raw + suffix, true)],
  }
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }]

  const result: Block[] = []
  let prefix = ""
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token) continue
    if (token.type === "space") {
      prefix += token.raw
      continue
    }
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw
    prefix += raw
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const parsedRaw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  // marked can normalize incomplete list tails. Keep the exact source tail
  // whenever the frozen prefix still matches so incremental projection never
  // manufactures bytes that were not emitted by the model.
  const raw = hasTextPrefix(text, prefix) ? text.slice(prefix.length) : parsedRaw
  if (last.type !== "code") {
    const src = heal(raw)
    // remend legitimately trims otherwise-semantic-free trailing whitespace.
    // Treat that as append-safe: once another plain token arrives we can use
    // the exact raw source again. Any other synthesized edit (closing emphasis,
    // link healing, list sentinel, etc.) remains an explicit reproject barrier.
    const trimmed = raw.trimEnd()
    const appendSafe = src === raw || (trimmed.length < raw.length && src === trimmed)
    return [...result, { raw, src, mode: "live", appendSafe }]
  }

  const code = last as Tokens.Code
  if (!open(code.raw)) return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]
  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

export function project(
  previous: Projection | undefined,
  text: string,
  live: boolean,
  appendFrom?: number,
  appendDelta?: string,
): Projection {
  const appendOnly =
    !!previous &&
    appendFrom === previous.text.length &&
    text.length >= previous.text.length &&
    (appendDelta === undefined || text.length === previous.text.length + appendDelta.length)
  if (!live) {
    const current =
      previous?.text === text
        ? previous
        : previous && appendOnly
          ? project(previous, text, true, appendFrom, appendDelta)
          : undefined
    if (!current) return completedProjection(text)
    return {
      text,
      blocks: current.blocks.map((block) => {
        if (block.mode === "live") return { raw: block.raw, src: block.raw, mode: "full" }
        if (block.mode === "code" && !block.complete) return { ...block, complete: true }
        return block
      }),
    }
  }
  // The message reducer supplies appendFrom for token-rate updates, proving the
  // exact previous length without re-walking the accumulated prefix. Any
  // unproven replacement takes the exact full-projection path; correctness does
  // not require an O(prefix) proof.
  if (!previous || !appendOnly) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = appendDelta ?? text.slice(previous.text.length)
  if (tail?.mode === "live" && suffix) {
    const appended = tail.raw + suffix
    if (crossesBlankLine(tail.raw, suffix)) return reprojectTail(previous, text, suffix)
    // Ordinary prose is the dominant token path. Keep it lexer-free until a
    // structural character can change markdown semantics or remend has already
    // synthesized temporary source.
    if (tail.appendSafe && !/[`*_~[\]()<>{}]/.test(suffix) && !suffix.includes("\n")) {
      const raw = appended
      return {
        text,
        blocks: [...previous.blocks.slice(0, -1), { ...tail, raw, src: raw, appendSafe: true }],
      }
    }
  }
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix)) {
    return reprojectTail(previous, text, suffix)
  }
  return {
    text,
    blocks: [
      ...previous.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  }
}
