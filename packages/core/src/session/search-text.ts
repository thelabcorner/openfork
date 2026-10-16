export * as SessionSearch from "./search-text"

import type { SessionMessage } from "./message"
import { SessionTurnProvenance } from "./turn-provenance"

// Tool call inputs and shell output are indexed as bounded summaries so the
// index stays small on large databases: the request/intent is searchable and
// error-snapshot text is findable, but full logs and raw results are not.
const MaxToolInputLength = 2000
const MaxShellOutputLength = 2000
const SnippetWindow = 120

const truncate = (input: string, max: number) => (input.length > max ? input.slice(0, max) : input)

export function toolSearchText(name: string, input: unknown, metadata?: unknown): string {
  if (name === "code") return codeToolSearchText(input, metadata)
  const prefix = `tool:${name}`
  const budget = Math.max(0, MaxToolInputLength - prefix.length - 1)
  const payload = truncate(JSON.stringify(input), budget)
  return payload ? `${prefix} ${payload}` : prefix
}

/**
 * Exact tool recall stores tool identity in a dedicated indexed column, so its
 * FTS payload should contain only bounded searchable input/lineage text. Broad
 * conversation search still uses toolSearchText() and retains tool:<name>.
 */
export function toolRecallSearchText(name: string, input: unknown, metadata?: unknown): string {
  const text = toolSearchText(name, input, metadata)
  const prefix = `tool:${name}`
  if (text === prefix) return ""
  return text.startsWith(`${prefix} `) ? text.slice(prefix.length + 1) : text
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/**
 * Code is a programmable authority surface, so its raw source/runtime input may
 * contain credentials, proprietary code, or large arbitrary payloads. Broad
 * session/run search must therefore index only bounded identity/lineage hints.
 */
function codeToolSearchText(input: unknown, metadata?: unknown): string {
  const value = record(input)
  const meta = record(metadata)
  const tokens = ["tool:code"]
  const add = (label: string, candidate: unknown) => {
    if (typeof candidate === "string" && candidate.length > 0) tokens.push(`${label}:${candidate}`)
  }

  add("action", value?.action)
  add("run", value?.runID)
  add("ref", value?.ref)
  add("target", value?.target)
  add("saved", value?.tool)

  const save = record(value?.save)
  add("save", save?.name)
  add("scope", save?.scope)
  for (const tag of strings(save?.tags).slice(0, 16)) add("tag", tag)

  add("source", meta?.sourceHash)
  add("replay", meta?.replayOf)
  add("sourceRun", meta?.sourceRunID)
  add("inputRun", meta?.inputRunID)

  const deps = record(meta?.dependencies)
  for (const ref of strings(deps?.literalRefs).slice(0, 64)) add("dep", ref)
  if (Array.isArray(meta?.dependencyContracts)) {
    for (const item of meta.dependencyContracts.slice(0, 64)) add("dep", record(item)?.ref)
  }
  const saved = record(meta?.saved)
  add("saved", saved?.id)
  add("savedHandle", saved?.handle)

  return truncate(tokens.join(" "), MaxToolInputLength)
}

export function assistantPartSearchText(part: SessionMessage.AssistantContent): string {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "tool") return toolSearchText(part.name, part.state.input)
  return ""
}

export function searchText(message: SessionMessage.Message): string {
  // Replaceable domain STATE is durable so replay/idempotence can reconstruct
  // it, but it is not historical conversation. Indexing every publication
  // would make superseded Goal specs/progress permanently discoverable.
  if (SessionTurnProvenance.isStateProjection(message)) return ""
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
      return message.content.map(assistantPartSearchText).filter(Boolean).join(" ")
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
  readonly synthetic?: boolean
  readonly ignored?: boolean
  readonly tool?: string
  readonly state?: { readonly input?: unknown; readonly metadata?: unknown }
}

export function partSearchText(part: V1PartSearchable): string {
  switch (part.type) {
    case "text":
      if (part.synthetic === true || part.ignored === true) return ""
      return part.text ?? ""
    case "reasoning":
      return part.text ?? ""
    case "tool":
      return toolSearchText(part.tool ?? "", part.state?.input ?? {}, part.state?.metadata)
    default:
      return ""
  }
}
