import { isCodeRunTrace, type CodeRunTraceView } from "@opencode-ai/schema/v1/session"

export type CodeOutputLifecycle = {
  parsed?: Record<string, unknown>
  trace?: CodeRunTraceView
  isError: boolean
}

export function parseCodeOutput(output?: string): Record<string, unknown> | undefined {
  if (!output) return undefined
  const trimmed = output.trim()
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Pure presentation projection shared by the Solid renderer and Bun tests.
 * Trace visibility is deliberately independent of final output success: live
 * progress and failed Code calls both retain the same schema-owned trace.
 */
export function codeOutputLifecycle(input: {
  output?: string
  metadata?: Record<string, unknown>
}): CodeOutputLifecycle {
  const parsed = parseCodeOutput(input.output)
  const rawTrace = input.metadata?.trace
  const trace = isCodeRunTrace(rawTrace) ? rawTrace : undefined
  return {
    ...(parsed ? { parsed } : {}),
    ...(trace ? { trace } : {}),
    isError: input.metadata?.error === true || parsed?.ok === false,
  }
}

export function codeAttachmentLabel(count: number): string {
  return `${count} attachment${count === 1 ? "" : "s"}`
}

export function codeTraceOmittedLabel(count: number): string {
  return `+${count} frame${count === 1 ? "" : "s"} omitted from the bounded retained trace`
}