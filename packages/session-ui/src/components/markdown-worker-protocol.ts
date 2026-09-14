import type { Block, Projection } from "./markdown-stream"
import { hasTextPrefix } from "./text-prefix"

export type MarkdownToken = [content: string, style: string]

export type MarkdownProjectionPatch = {
  /** Number of leading blocks preserved from the preceding projection. */
  keep: number
  /** Replacement suffix beginning at `keep`. */
  blocks: Block[]
}

export type HostMarkdownParseRequest = {
  type: "parse"
  id: number
  key: string
  text: string
}

export type MarkdownParseRequest =
  | (HostMarkdownParseRequest & { reset: true })
  | { type: "parse"; id: number; key: string; baseLength: number; append: string }

export type MarkdownProjectRequest =
  | { type: "project"; id: number; key: string; live: boolean; text: string; reset: true }
  | { type: "project"; id: number; key: string; live: boolean; baseLength: number; append: string }

export type HostMarkdownHighlightRequest = {
  type: "highlight"
  id: number
  key: string
  text: string
  language: string
  complete?: boolean
}

export type MarkdownHighlightRequest =
  | (Omit<HostMarkdownHighlightRequest, "text"> & { text: string; reset: true })
  | (Omit<HostMarkdownHighlightRequest, "text" | "complete"> & {
      complete?: false
      baseLength: number
      append: string
    })

export type MarkdownWorkerRequest =
  | MarkdownParseRequest
  | MarkdownProjectRequest
  | MarkdownHighlightRequest
  | { type: "dispose"; key: string }

export type MarkdownWorkerResponse =
  | {
      type: "parse"
      id: number
      key: string
      html: string
      incremental?: boolean
      workerMs?: number
      workerQueueMs?: number
    }
  | { type: "parse-miss"; id: number; key: string }
  | { type: "project"; id: number; key: string; patch: MarkdownProjectionPatch; workerMs?: number; workerQueueMs?: number }
  | { type: "project-miss"; id: number; key: string }
  | { type: "highlight-miss"; id: number; key: string }
  | {
      type: "highlight"
      id: number
      key: string
      language: string
      reset: boolean
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
      workerMs?: number
      workerQueueMs?: number
    }
  | { type: "error"; id: number; key?: string; message: string; workerMs?: number; workerQueueMs?: number }
  | { type: "superseded"; id: number; key: string }

export type MarkdownWorkerState = {
  id: number
  generation: number
  language: string
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

export function shouldReleaseMarkdownWorkerState(complete: boolean, latestID: number | undefined, responseID: number) {
  return complete && latestID === responseID
}

export function markdownBlockKey(owner: string, cacheKey: string | undefined, index: number, mode: string) {
  return `${owner}:${cacheKey ? `${cacheKey}:${index}:${mode}` : `block:${index}`}`
}

/** Convert a host full-source parse request into a reset or append-only wire request. */
export function markdownParseRequest(request: HostMarkdownParseRequest, previous?: string): MarkdownParseRequest {
  if (previous !== undefined && hasTextPrefix(request.text, previous)) {
    return {
      type: "parse",
      id: request.id,
      key: request.key,
      baseLength: previous.length,
      append: request.text.slice(previous.length),
    }
  }
  return { ...request, reset: true }
}

/**
 * Convert a host-side full code snapshot into the smallest safe worker request.
 * Completed code is deliberately sent as one final reset because full Shiki
 * tokenization requires the complete source exactly once. Live append-only
 * updates carry only the new suffix; replacement/language changes reset.
 */
export function markdownHighlightRequest(
  request: HostMarkdownHighlightRequest,
  previous?: { text: string; language: string },
): MarkdownHighlightRequest {
  if (
    !request.complete &&
    previous?.language === request.language &&
    hasTextPrefix(request.text, previous.text)
  ) {
    return {
      type: "highlight",
      id: request.id,
      key: request.key,
      language: request.language,
      baseLength: previous.text.length,
      append: request.text.slice(previous.text.length),
    }
  }
  return { ...request, reset: true }
}

/**
 * Build an identity-based projection suffix while both projections still live
 * in the worker. `project()` deliberately preserves frozen block objects across
 * append-only updates, so the common prefix check is O(number of blocks) with
 * no text comparisons and the wire only receives the changing tail.
 */
export function diffMarkdownProjection(
  previous: Projection | undefined,
  next: Projection,
): MarkdownProjectionPatch {
  let keep = 0
  if (previous) {
    const end = Math.min(previous.blocks.length, next.blocks.length)
    while (keep < end && previous.blocks[keep] === next.blocks[keep]) keep++
  }
  return { keep, blocks: next.blocks.slice(keep) }
}

/** Reconstruct a worker projection suffix against the host's retained prefix. */
export function applyMarkdownProjectionPatch(
  previous: Projection | undefined,
  text: string,
  patch: MarkdownProjectionPatch,
): Projection {
  const available = previous?.blocks.length ?? 0
  if (patch.keep > available) throw new Error(`Markdown projection patch desync: keep=${patch.keep}, available=${available}`)
  return {
    text,
    blocks: [...(previous?.blocks.slice(0, patch.keep) ?? []), ...patch.blocks],
  }
}

export function applyMarkdownWorkerResponse(
  state: MarkdownWorkerState | undefined,
  response: Extract<MarkdownWorkerResponse, { type: "highlight" }>,
) {
  if (state && response.id <= state.id) return state
  return {
    id: response.id,
    generation: (state?.generation ?? 0) + (response.reset ? 1 : 0),
    language: response.language,
    stable: response.reset ? response.stable : [...(state?.stable ?? []), ...response.stable],
    unstable: response.unstable,
  }
}
