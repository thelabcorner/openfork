export * as SpecialAgentSessionContext from "./special-agent-session-context"

import { SessionMessage } from "./session/message"

export interface Options {
  readonly maxChars: number
  readonly maxBlockChars?: number
  readonly includeShell?: boolean
  readonly pinOpeningUser?: boolean
  readonly pinLatestCompaction?: boolean
}

type Block = {
  readonly index: number
  readonly text: string
  readonly kind: "user" | "assistant" | "shell" | "compaction"
}

const truncateMiddle = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value
  if (maxChars <= 64) return value.slice(0, maxChars)
  const marker = "\n...[truncated]...\n"
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(remaining * 0.55)
  const tail = remaining - head
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`
}

const render = (message: SessionMessage.Message, includeShell: boolean): Omit<Block, "index"> | undefined => {
  switch (message.type) {
    case "user":
      return { kind: "user", text: `<user>\n${message.text}\n</user>` }
    case "assistant": {
      const text = message.content
        .filter((part): part is SessionMessage.AssistantText => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      return text ? { kind: "assistant", text: `<assistant>\n${text}\n</assistant>` } : undefined
    }
    case "shell":
      return includeShell && message.output
        ? { kind: "shell", text: `<shell>\n${message.output}\n</shell>` }
        : undefined
    case "compaction": {
      const body = [
        message.summary.trim() ? `<summary>\n${message.summary.trim()}\n</summary>` : undefined,
        message.recent.trim() ? `<recent>\n${message.recent.trim()}\n</recent>` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n")
      return body ? { kind: "compaction", text: `<conversation-summary>\n${body}\n</conversation-summary>` } : undefined
    }
    default:
      return undefined
  }
}

/**
 * Builds bounded conversation context for short-lived special agents.
 *
 * Important properties:
 * - a compaction summary supersedes earlier transcript replay;
 * - the latest useful context is filled newest-first;
 * - oversized individual turns are truncated rather than aborting collection;
 * - without a compaction, the opening user intent can be pinned at the front.
 */
export function assemble(messages: readonly SessionMessage.Message[], options: Options) {
  const maxChars = Math.max(512, Math.floor(options.maxChars))
  const maxBlockChars = Math.max(
    256,
    Math.min(maxChars, Math.floor(options.maxBlockChars ?? Math.min(8_000, maxChars))),
  )
  const includeShell = options.includeShell ?? false
  const pinOpeningUser = options.pinOpeningUser ?? true
  const pinLatestCompaction = options.pinLatestCompaction ?? true

  let latestCompaction = -1
  if (pinLatestCompaction) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.type === "compaction") {
        latestCompaction = index
        break
      }
    }
  }

  const floor = latestCompaction >= 0 ? latestCompaction : 0
  const rendered: Block[] = []
  for (let index = floor; index < messages.length; index++) {
    const block = render(messages[index]!, includeShell)
    if (!block) continue
    rendered.push({ ...block, index, text: truncateMiddle(block.text, maxBlockChars) })
  }

  const selected = new Map<number, Block>()
  let chars = 0
  const add = (block: Block, front = false) => {
    if (selected.has(block.index)) return
    const separator = selected.size > 0 ? 2 : 0
    const remaining = maxChars - chars - separator
    if (remaining <= 0) return
    const text = truncateMiddle(block.text, remaining)
    if (!text) return
    const next = { ...block, text }
    selected.set(block.index, next)
    chars += text.length + separator
    if (front) {
      // insertion order is normalized by index at the end; this flag documents
      // that the caller intentionally reserved budget for this block first.
    }
  }

  if (latestCompaction >= 0) {
    const summary = rendered.find((block) => block.index === latestCompaction && block.kind === "compaction")
    if (summary) add(summary, true)
  } else if (pinOpeningUser) {
    const opening = rendered.find((block) => block.kind === "user")
    if (opening) add(opening, true)
  }

  for (let index = rendered.length - 1; index >= 0; index--) add(rendered[index]!)

  return [...selected.values()]
    .sort((a, b) => a.index - b.index)
    .map((block) => block.text)
    .join("\n\n")
}
