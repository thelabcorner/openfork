import type { CodeRunTraceView } from "@opencode-ai/core/v1/session"

export function codeTracePresentation(trace: CodeRunTraceView, limit = 5): string[] {
  const lines: string[] = []
  const calls = trace.counters.calls
  const failed = trace.counters.failed
  const active = trace.counters.active

  if (calls > 0) {
    lines.push(
      `↳ ${calls} call${calls === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}${active ? `, ${active} active` : ""}`,
    )
  }

  const visible = trace.frames.slice(0, limit)
  for (const frame of visible) {
    const marker =
      frame.status === "failed" || frame.status === "cancelled"
        ? "✗"
        : frame.status === "running"
          ? "…"
          : "✓"
    const title = frame.title && frame.title !== frame.ref ? ` — ${frame.title}` : ""
    const attachments =
      frame.attachmentCount && frame.attachmentCount > 0
        ? ` · ${frame.attachmentCount} attachment${frame.attachmentCount === 1 ? "" : "s"}`
        : ""
    lines.push(`${"  ".repeat(Math.min(frame.depth, 4))}↳ ${marker} ${frame.ref}${title}${attachments}`)
  }

  const previewOmitted = Math.max(0, trace.frames.length - visible.length)
  if (previewOmitted > 0) {
    lines.push(`↳ … ${previewOmitted} retained frame${previewOmitted === 1 ? "" : "s"} not shown`)
  }

  const retainedOmitted = trace.truncated?.frames ?? 0
  if (retainedOmitted > 0) {
    lines.push(`↳ trace capped · ${retainedOmitted} frame${retainedOmitted === 1 ? "" : "s"} not retained`)
  }
  return lines
}