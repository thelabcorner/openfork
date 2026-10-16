import type { PromptInputV2Prompt } from "@opencode-ai/session-ui/v2/prompt-input/types"
import type {
  CompatibleRevisionDraftArtifact,
  CompatibleRevisionProgress,
  CompatibleRevisionRunStatus,
} from "@/utils/server-compat"

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

export function promptRevisionUsablePath(value: unknown) {
  if (typeof value !== "string") return undefined
  const path = value.trim()
  if (!path) return undefined
  const sentinel = path.toLowerCase()
  if (sentinel === "null" || sentinel === "undefined") return undefined
  return path
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
    // Tool mentions are local composer semantics. Their visible @tool token is
    // already present in the draft text and revisedPromptParts can recover the
    // original atomic part from that token. Do not widen the special-agent HTTP
    // reference protocol just to transmit runtime tool identity.
    if (part.type === "tool") return
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
      const path = promptRevisionUsablePath((part as { path?: unknown }).path)
      if (!path) return
      mentions.push({ id, type: "reference", token: part.content, name: part.filename, path })
      return
    }
    const path = promptRevisionUsablePath((part as { path?: unknown }).path)
    if (!path) return
    mentions.push({
      id,
      type: "file",
      token: part.content,
      path,
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

/**
 * Text equality is insufficient for Prompt recovery because a revision may
 * carry structured file/agent/skill/resource references. Reconstruct the
 * canonical revised parts over the hydrated durable draft and compare the full
 * structural fingerprint before treating the artifact as already owned.
 */
export function promptRevisionArtifactIsApplied(
  current: PromptInputV2Prompt,
  text: string,
  references: readonly PromptRevisionReference[] = [],
) {
  if (promptRevisionText(current) !== text) return false
  const candidate = revisedPromptParts(text, current, references)
  return promptRevisionFingerprint(candidate) === promptRevisionFingerprint(current)
}

/** One bounded-cadence poll for one in-flight revision. Stops on settle/abort. */
export const REVISION_PROGRESS_POLL_MS = 800

const waitForProgressPoll = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })

/**
 * The Prompt Revisor POST is synchronous, so the composer correlates live
 * progress with its own client-generated operation id instead of trying to
 * thread a request identity through a server-side event bus. Exactly one
 * bounded-cadence poller runs per revision: it starts with the request, keeps
 * only well-formed snapshots for the still-current flow, and stops as soon as
 * the flow settles or is superseded. `read` returning null (no update yet,
 * settled projection, legacy server without the route) never fails the poll.
 */
export async function pollRevisionProgress(input: {
  operationID: string
  read: (operationID: string, signal: AbortSignal) => Promise<CompatibleRevisionProgress | null>
  isCurrent: () => boolean
  onUpdate: (progress: CompatibleRevisionProgress) => void
  signal: AbortSignal
  intervalMs?: number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const wait = input.wait ?? waitForProgressPoll
  while (!input.signal.aborted) {
    await wait(input.intervalMs ?? REVISION_PROGRESS_POLL_MS, input.signal)
    if (input.signal.aborted || !input.isCurrent()) return
    let next: CompatibleRevisionProgress | null = null
    try {
      next = await input.read(input.operationID, input.signal)
    } catch {
      if (input.signal.aborted) return
      continue
    }
    if (input.signal.aborted || !input.isCurrent()) return
    if (next) input.onUpdate(next)
  }
}

export type RevisionRunningStatus = Extract<CompatibleRevisionRunStatus, { state: "running" }>
export type RevisionFailedStatus = Extract<CompatibleRevisionRunStatus, { state: "failed" }>

/**
 * Supervisor for one revision run this component did not itself start, for
 * example after a tab switch disposed the original composer.
 *
 * A returning client needs three facts without duplicating the progress poll:
 * the run is still in flight (keep showing busy + latest progress under the
 * correlation id reported by the server), it failed (surface the retained
 * message), or it left the registry (re-check the durable mailbox and apply a
 * committed artifact). Status is read first and then on the same bounded
 * cadence as progress, so a run is never reconstructed from rendered text.
 */
export async function pollRevisionRun(input: {
  readStatus: (signal: AbortSignal) => Promise<CompatibleRevisionRunStatus | null>
  readProgress?: (operationID: string, signal: AbortSignal) => Promise<CompatibleRevisionProgress | null>
  /** True when a durable artifact was handled (applied, consumed, or offered). */
  recover: (signal: AbortSignal) => Promise<boolean>
  onRunning: (status: RevisionRunningStatus) => void
  onProgress?: (progress: CompatibleRevisionProgress) => void
  onFailed: (status: RevisionFailedStatus) => void
  isCurrent: () => boolean
  signal: AbortSignal
  intervalMs?: number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const wait = input.wait ?? waitForProgressPoll
  let operationID: string | undefined
  while (!input.signal.aborted && input.isCurrent()) {
    let status: CompatibleRevisionRunStatus | null = null
    let readFailed = false
    try {
      status = await input.readStatus(input.signal)
    } catch {
      readFailed = true
    }
    if (input.signal.aborted || !input.isCurrent()) return
    if (!readFailed) {
      if (status?.state === "failed") {
        input.onFailed(status)
        return
      }
      if (status?.state === "running") {
        if (status.operationID !== undefined) operationID = status.operationID
        input.onRunning(status)
        if (operationID !== undefined && input.readProgress) {
          try {
            const progress = await input.readProgress(operationID, input.signal)
            if (!input.signal.aborted && input.isCurrent() && progress) input.onProgress?.(progress)
          } catch {
            // Advisory only; the next bounded tick retries.
          }
        }
      } else {
        // Untracked: the run settled, was consumed elsewhere, was explicitly
        // cancelled, or never existed. A committed artifact is the only
        // authoritative completion signal left.
        if (await input.recover(input.signal)) return
        return
      }
    }
    await wait(input.intervalMs ?? REVISION_PROGRESS_POLL_MS, input.signal)
  }
}

/**
 * Local controls for one resumed run. `abort` tears down these polls only:
 * the run is owned by the server registry, so unmounting a composer must never
 * be treated as cancellation. Only an explicit cancel endpoint call ends it.
 */
export function resumeRevisionRun(input: Omit<Parameters<typeof pollRevisionRun>[0], "signal">): {
  abort: () => void
  done: Promise<void>
} {
  const controller = new AbortController()
  return { abort: () => controller.abort(), done: pollRevisionRun({ ...input, signal: controller.signal }) }
}

/**
 * Explicit user cancellation. Calls the server-owned cancel endpoint and never
 * throws: `false` means "nothing to cancel", which is also what an older server
 * without the route reports, so callers keep their local-abort fallback there.
 */
export async function cancelRevisionRun(input: {
  kind: CompatibleRevisionDraftArtifact["kind"]
  key: string
  operationID?: string
  cancel: (input: {
    kind: CompatibleRevisionDraftArtifact["kind"]
    key: string
    operationID?: string
  }) => Promise<boolean>
}): Promise<boolean> {
  try {
    return await input.cancel({
      kind: input.kind,
      key: input.key,
      ...(input.operationID === undefined ? {} : { operationID: input.operationID }),
    })
  } catch {
    return false
  }
}
