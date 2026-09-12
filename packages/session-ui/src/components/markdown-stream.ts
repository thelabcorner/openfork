import { marked, type Tokens } from "marked"
import remend from "remend"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
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

// remend's setext-heading guard treats a trailing `-` line as a pending setext
// underline and appends U+200B directly to the dash. Inside a list that changes
// the marker into plain text, so an item temporarily collapses into its parent
// and re-splits when the next character arrives. For a nested first item,
// simply removing the guard is not enough: `- parent\n  -` is itself parsed as
// a setext heading. Instead, when marked confirms that the source immediately
// before the pending marker is still a list and that the marker is valid at its
// current indentation, give the empty item invisible content (`- <U+200B>`).
// That preserves the list DOM shape from the first streamed marker onward.
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

  // A setext underline after ordinary prose must retain remend's original
  // protection. We only prefer list semantics while the preceding source is
  // already parsed as a list. This also handles a fresh list after a blank line
  // and switches between ordered/unordered list kinds.
  const before = marked.lexer(text.slice(0, newline))
  const previous = before.findLast((token) => token.type !== "space")
  if (previous?.type !== "list") return undefined

  const candidate = `${text.replace(/[ \t]+$/, "")} ${STREAM_LIST_SENTINEL}`
  // Let marked enforce CommonMark indentation instead of duplicating list
  // width/depth rules here. Excessively indented dashes remain prose/code and
  // therefore keep remend's setext guard.
  if (!containsStreamListSentinel(marked.lexer(candidate))) return undefined
  return candidate
}

function heal(text: string) {
  return remend(stabilizePendingList(text) ?? text, { linkMode: "text-only" })
}

const BLANK_LINE = /\r?\n[ \t]*\r?\n/
const BLANK_LINE_AT_END = /\r?\n[ \t]*\r?\n[ \t]*$/

function crossesBlankLine(raw: string, suffix: string) {
  if (BLANK_LINE.test(suffix)) return true
  if (BLANK_LINE_AT_END.test(raw)) return true
  const newline = raw.lastIndexOf("\n")
  if (newline < 0) return false
  return BLANK_LINE.test(raw.slice(newline) + suffix)
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

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
  // marked normalizes some incomplete list tails (notably a trailing `- `) by
  // replacing the source whitespace with a newline. Keep the exact source tail
  // whenever the already-frozen prefix still matches, otherwise incremental
  // projection can manufacture bytes that never existed in the model output.
  const raw = text.startsWith(prefix) ? text.slice(prefix.length) : parsedRaw
  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  const code = last as Tokens.Code
  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]
  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live) {
    const current =
      previous?.text === text
        ? previous
        : previous && text.startsWith(previous.text)
          ? project(previous, text, true)
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
  if (!previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (tail?.mode === "live" && suffix) {
    const appended = tail.raw + suffix
    // A blank line can close the current top-level block. Resolve that boundary
    // before the plain-text fast path so the next block cannot be appended into
    // the old live DOM subtree and then split out later when some unrelated
    // structural character (for example an inline-code backtick) finally forces
    // a reparse. Use stream() rather than slicing at the raw blank line because
    // blank lines can also legally occur inside a single list block.
    if (crossesBlankLine(tail.raw, suffix)) {
      return {
        text,
        blocks: [...previous.blocks.slice(0, -1), ...stream(appended, true)],
      }
    }
    // Plain prose can be appended directly only while the rendered source is
    // identical to the raw source. If remend (or the list stabilizer above)
    // synthesized anything, the next character may resolve that temporary
    // syntax and must be healed again instead of appended after the synthetic
    // suffix. This keeps the fast path for ordinary prose without freezing
    // placeholders or closing syntax into the live block.
    if (tail.src === tail.raw && !/[`*_~[\]()<>{}]/.test(suffix) && !suffix.includes("\n")) {
      return {
        text,
        blocks: [...previous.blocks.slice(0, -1), { ...tail, raw: appended, src: tail.src + suffix }],
      }
    }
  }
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) }
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
