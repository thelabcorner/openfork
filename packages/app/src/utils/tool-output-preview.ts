import type { Part } from "@opencode-ai/sdk/v2/client"

const TOOL_OUTPUT_STREAM_PREVIEW_CHARS = 64 * 1024
const TOOL_OUTPUT_OMITTED_PREFIX = "[Earlier output omitted while the tool is running]\n"

export function runningToolOutputPreview(value: unknown) {
  if (typeof value !== "string") return value
  const tail = value.startsWith(TOOL_OUTPUT_OMITTED_PREFIX) ? value.slice(TOOL_OUTPUT_OMITTED_PREFIX.length) : value
  if (tail.length <= TOOL_OUTPUT_STREAM_PREVIEW_CHARS) return value
  return TOOL_OUTPUT_OMITTED_PREFIX + tail.slice(-TOOL_OUTPUT_STREAM_PREVIEW_CHARS)
}

export function appendRunningToolOutputPreview(current: unknown, delta: string) {
  const output = typeof current === "string" ? current : ""
  const tail = output.startsWith(TOOL_OUTPUT_OMITTED_PREFIX) ? output.slice(TOOL_OUTPUT_OMITTED_PREFIX.length) : output
  const next = tail + delta
  if (next.length <= TOOL_OUTPUT_STREAM_PREVIEW_CHARS && !output.startsWith(TOOL_OUTPUT_OMITTED_PREFIX)) return next
  return TOOL_OUTPUT_OMITTED_PREFIX + next.slice(-TOOL_OUTPUT_STREAM_PREVIEW_CHARS)
}

export function runningToolPartPreview(part: Part): Part {
  if (part.type !== "tool" || part.state.status !== "running") return part
  const output = part.state.metadata?.output
  const preview = runningToolOutputPreview(output)
  if (preview === output) return part
  return {
    ...part,
    state: {
      ...part.state,
      metadata: { ...part.state.metadata, output: preview as string },
    },
  }
}
