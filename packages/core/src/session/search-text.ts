export * as SessionSearch from "./search-text"

import type { SessionMessage } from "./message"

// Tool call inputs and shell output are indexed as bounded summaries so the
// index stays small on large databases: the request/intent is searchable and
// error-snapshot text is findable, but full logs and raw results are not.
const MaxToolInputLength = 2000
const MaxShellOutputLength = 2000
const SnippetWindow = 120

const truncate = (input: string, max: number) => (input.length > max ? input.slice(0, max) : input)

export function searchText(message: SessionMessage.Message): string {
  switch (message.type) {
    case "user":
    case "synthetic":
    case "system":
      return message.text
    case "compaction":
      return `${message.summary} ${message.recent}`.trim()
    case "shell":
      return `${message.command} ${truncate(message.output, MaxShellOutputLength)}`.trim()
    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text" || part.type === "reasoning") return [part.text]
          if (part.type === "tool") return [truncate(JSON.stringify(part.state.input), MaxToolInputLength)]
          return []
        })
        .join(" ")
    default:
      // agent-switched and model-switched carry no searchable content.
      return ""
  }
}

export function snippet(text: string, terms: readonly string[]): string {
  if (text.length <= SnippetWindow) return text
  const normalized = text.toLocaleLowerCase()
  let index = -1
  for (const term of terms) {
    const at = normalized.indexOf(term.toLocaleLowerCase())
    if (at !== -1 && (index === -1 || at < index)) index = at
  }
  // No term found in this text: show the head of the text.
  const start = index === -1 ? 0 : Math.max(0, index - Math.floor(SnippetWindow / 3))
  const end = Math.min(text.length, start + SnippetWindow)
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

// V1 parts carry conversation content in their JSON data: text and reasoning
// parts hold the actual prose, tool parts hold a bounded summary of the tool
// input. Everything else (step boundaries, patches, snapshots, agents) is not
// indexed, mirroring the V2 extractor's semantics.
export type V1PartSearchable = {
  readonly type: string
  readonly text?: string
  readonly tool?: string
  readonly state?: { readonly input?: unknown }
}

export function partSearchText(part: V1PartSearchable): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text ?? ""
    case "tool":
      return `tool:${part.tool ?? ""} ${truncate(JSON.stringify(part.state?.input ?? {}), MaxToolInputLength)}`.trim()
    default:
      return ""
  }
}
