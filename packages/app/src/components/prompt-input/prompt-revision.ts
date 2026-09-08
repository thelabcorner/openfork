import type { PromptInputV2Prompt } from "@opencode-ai/session-ui/v2/prompt-input/types"
import { normalizeReply } from "@opencode-ai/core/question-normalize"

export type PromptRevisionQuestionLike = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

export type PromptRevisionClarification = {
  question: string
  answers: string[]
  detail?: string
}

export type PromptRevisionResponse = {
  answers: string[][]
  details: string[]
}

export type PromptRevisionReference =
  | {
      type: "file"
      content: string
      start: number
      end: number
      path: string
      selection?: { startLine: number; startChar: number; endLine: number; endChar: number }
    }
  | { type: "agent"; content: string; start: number; end: number; name: string }
  | { type: "skill"; content: string; start: number; end: number; name: string }
  | { type: "reference"; content: string; start: number; end: number; name: string; path: string }
  | {
      type: "resource"
      content: string
      start: number
      end: number
      name: string
      clientName: string
      uri: string
      mimeType?: string
    }

export type PromptRevisionDraftContext = {
  mentions: (
    | {
        id: string
        type: "file"
        token: string
        path: string
        selection?: { startLine: number; startChar: number; endLine: number; endChar: number }
      }
    | { id: string; type: "agent"; token: string; name: string }
    | { id: string; type: "skill"; token: string; name: string }
    | { id: string; type: "reference"; token: string; name: string; path: string }
    | { id: string; type: "resource"; token: string; name: string; clientName: string; uri: string }
  )[]
  attachments: { id: string; type: "image"; filename: string; mime: string }[]
}

export function promptRevisionFingerprint(parts: PromptInputV2Prompt) {
  return JSON.stringify(parts)
}

export function promptRevisionText(parts: PromptInputV2Prompt) {
  return parts
    .filter((part) => part.type !== "image")
    .map((part) => part.content)
    .join("")
}

export function promptRevisionDraftContext(parts: PromptInputV2Prompt): PromptRevisionDraftContext {
  const mentions: PromptRevisionDraftContext["mentions"] = []
  const attachments: PromptRevisionDraftContext["attachments"] = []
  parts.forEach((part, index) => {
    if (part.type === "image") {
      attachments.push({ id: part.id, type: "image", filename: part.filename, mime: part.mime })
      return
    }
    if (part.type === "text" || part.type === "external-path") return
    const id = `m${index}`
    if (part.type === "agent") {
      mentions.push({ id, type: "agent", token: part.content, name: part.name })
      return
    }
    if (part.type === "skill") {
      mentions.push({ id, type: "skill", token: part.content, name: part.name })
      return
    }
    if (part.source?.type === "resource") {
      mentions.push({
        id,
        type: "resource",
        token: part.content,
        name: part.filename ?? part.content.replace(/^@/, ""),
        clientName: part.source.clientName,
        uri: part.source.uri,
      })
      return
    }
    if (part.mime === "application/x-directory" && part.filename) {
      mentions.push({ id, type: "reference", token: part.content, name: part.filename, path: part.path })
      return
    }
    mentions.push({
      id,
      type: "file",
      token: part.content,
      path: part.path,
      ...(part.selection ? { selection: { ...part.selection } } : {}),
    })
  })
  return { mentions, attachments }
}

export function promptRevisionPrefix(parts: PromptInputV2Prompt, end: number): PromptInputV2Prompt {
  const images = parts.filter((part) => part.type === "image")
  const visible = parts.filter(
    (part): part is Exclude<PromptInputV2Prompt[number], { type: "image" }> => part.type !== "image",
  )
  const length = promptRevisionText(parts).length
  const capped = Math.max(0, Math.min(length, end))
  const prefix: PromptInputV2Prompt = []

  for (const part of visible) {
    if (part.start >= capped) break
    if (part.type !== "text") {
      // Mentions/references are atomic editor nodes. Never expose a half-formed
      // structured part during the fake stream; the reveal boundary helper
      // normally advances directly to `part.end`, and this guard keeps callers
      // safe if they pass an arbitrary character offset.
      if (part.end > capped) break
      prefix.push(part)
      continue
    }
    const partEnd = Math.min(part.end, capped)
    const content = part.content.slice(0, Math.max(0, partEnd - part.start))
    if (!content) continue
    prefix.push({ ...part, content, end: part.start + content.length })
    if (partEnd < part.end) break
  }

  return [...prefix, ...images]
}

export function promptRevisionRevealBoundaries(parts: PromptInputV2Prompt, maxFrames = 96) {
  const text = promptRevisionText(parts)
  if (!text.length) return []

  const semantic = parts
    .filter(
      (part): part is Exclude<PromptInputV2Prompt[number], { type: "text" } | { type: "image" }> =>
        part.type !== "text" && part.type !== "image",
    )
    .map((part) => ({ start: part.start, end: part.end }))

  const raw: number[] = []
  for (const match of text.matchAll(/\S+\s*/gu)) raw.push(match.index + match[0].length)
  if (raw.at(-1) !== text.length) raw.push(text.length)

  const normalized = raw.map((boundary) => {
    const inside = semantic.find((part) => boundary > part.start && boundary < part.end)
    return inside?.end ?? boundary
  })
  const unique = [...new Set(normalized)].filter((boundary) => boundary > 0).sort((a, b) => a - b)
  if (unique.at(-1) !== text.length) unique.push(text.length)

  const cap = Math.max(1, Math.floor(maxFrames))
  if (unique.length <= cap) return unique
  const stride = Math.ceil(unique.length / cap)
  const sampled = unique.filter((_, index) => (index + 1) % stride === 0)
  if (sampled.at(-1) !== text.length) sampled.push(text.length)
  return sampled
}

export function revisedPromptParts(
  text: string,
  original: PromptInputV2Prompt,
  references: readonly PromptRevisionReference[] = [],
): PromptInputV2Prompt {
  const images = original.filter((part) => part.type === "image")
  const semantic = original.filter(
    (part): part is Exclude<PromptInputV2Prompt[number], { type: "text" } | { type: "image" }> =>
      part.type !== "text" && part.type !== "image",
  )

  // A prompt may mention the same token more than once with different metadata
  // (for example, two references to the same file with different selections).
  // Preserve each original structured reference at most once instead of turning
  // every textual occurrence emitted by the revisor into a new attachment.
  const prototypes = new Map<string, typeof semantic>()
  for (const part of semantic) {
    if (!part.content) continue
    const list = prototypes.get(part.content)
    if (list) list.push(part)
    else prototypes.set(part.content, [part])
  }

  type SemanticPart = (typeof semantic)[number]
  type Span = { start: number; end: number; part: SemanticPart }
  const declared: Span[] = []
  for (const reference of references) {
    if (reference.start < 0 || reference.end > text.length || reference.end <= reference.start) continue
    if (text.slice(reference.start, reference.end) !== reference.content) continue
    let part: SemanticPart
    if (reference.type === "file") {
      part = {
        type: "file",
        path: reference.path,
        content: reference.content,
        start: reference.start,
        end: reference.end,
        ...(reference.selection ? { selection: { ...reference.selection } } : {}),
      }
    } else if (reference.type === "agent") {
      part = {
        type: "agent",
        name: reference.name,
        content: reference.content,
        start: reference.start,
        end: reference.end,
      }
    } else if (reference.type === "skill") {
      part = {
        type: "skill",
        name: reference.name,
        content: reference.content,
        start: reference.start,
        end: reference.end,
      }
    } else if (reference.type === "reference") {
      part = {
        type: "file",
        path: reference.path,
        content: reference.content,
        start: reference.start,
        end: reference.end,
        mime: "application/x-directory",
        filename: reference.name,
      }
    } else {
      part = {
        type: "file" as const,
        path: reference.uri,
        content: reference.content,
        start: reference.start,
        end: reference.end,
        mime: reference.mimeType ?? "text/plain",
        filename: reference.name,
        url: reference.uri,
        source: {
          type: "resource" as const,
          text: { value: reference.content, start: reference.start, end: reference.end },
          clientName: reference.clientName,
          uri: reference.uri,
        },
      }
    }
    declared.push({ start: reference.start, end: reference.end, part })
  }

  const spans: Span[] = [...prototypes.entries()]
    .flatMap(([content, parts]) => {
      const found: Span[] = []
      let offset = 0
      let occurrence = 0
      while (offset < text.length && occurrence < parts.length) {
        const start = text.indexOf(content, offset)
        if (start === -1) break
        found.push({ start, end: start + content.length, part: parts[occurrence]! })
        occurrence += 1
        offset = start + Math.max(1, content.length)
      }
      return found
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

  const selected: Span[] = [...declared].sort((a, b) => a.start - b.start)
  for (const span of spans) {
    if (selected.some((current) => span.start < current.end && span.end > current.start)) continue
    selected.push(span)
  }
  selected.sort((a, b) => a.start - b.start)

  const parts: PromptInputV2Prompt = []
  let cursor = 0
  for (const span of selected) {
    if (span.start > cursor) {
      parts.push({ type: "text", content: text.slice(cursor, span.start), start: cursor, end: span.start })
    }
    parts.push({ ...span.part, start: span.start, end: span.end })
    cursor = span.end
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ type: "text", content: text.slice(cursor), start: cursor, end: text.length })
  }
  return [...parts, ...images]
}

export function promptRevisionResponse(
  questions: readonly PromptRevisionQuestionLike[],
  answers: readonly (readonly string[])[],
  details: readonly string[],
): PromptRevisionResponse {
  const resolved = normalizeReply(questions, { answers, details })
  return {
    answers: resolved.answers.map((answer) => [...answer]),
    details: [...resolved.details],
  }
}

export function promptRevisionClarifications(
  questions: readonly PromptRevisionQuestionLike[],
  response: PromptRevisionResponse,
): PromptRevisionClarification[] {
  return questions.map((question, index) => ({
    question: question.question,
    answers: [...(response.answers[index] ?? [])],
    ...(response.details[index]?.trim() ? { detail: response.details[index]!.trim() } : {}),
  }))
}
