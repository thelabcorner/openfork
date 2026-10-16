import { tagBlocks, tagText } from "./tool-output-xml"

/**
 * Recorded-evidence presentation model for the `background` tool.
 *
 * `background` records each acknowledgement as tagged text on the tool part
 * itself (see `renderMonitorStarted` and the per-action output strings in
 * packages/opencode/src/tool/background.ts) and records the job's launch facts in
 * the same part's metadata. Everything below reads only that recorded text, so a
 * monitor started hours ago still renders the job id, command and log path it was
 * launched with instead of a snapshot of a process that may since have exited.
 *
 * This module deliberately owns no lifecycle. `BackgroundJob` owns job state and
 * scopes; `ShellJobs` owns the live child-process handles. Presentation here may
 * only reuse the ids and paths those owners already recorded - never start, stop,
 * re-enumerate or "refresh" a process, and never infer status from anything but
 * the part being rendered.
 */

/** Which recorded shape a `background` tool part carries. */
export type BackgroundShape = "list" | "monitor" | "job" | "read" | "text"

/**
 * Routes a `background` part to its renderer.
 *
 * `action: "monitor"` produces a `<monitor>` block, not a `<job>` one, so a
 * monitor has to be recognised by its own recorded shape. Anything else drops it
 * into the markdown fallback, which strips the block wrapper and leaves the
 * command wrapped mid-flag with no monospace. A shape that cannot be recognised
 * degrades to `"text"` instead of being guessed at.
 */
export function backgroundShape(input: { action?: unknown; output: string }): BackgroundShape {
  const action = typeof input.action === "string" ? input.action : undefined
  if (action === "list") return "list"
  if (action === "monitor") return tagBlocks(input.output, "monitor").length > 0 ? "monitor" : "text"
  if (tagBlocks(input.output, "job").length > 0) return "job"
  if (action === "read") return "read"
  return "text"
}

/** The fields a recorded `<monitor>` block carries about its job. */
export type MonitorBlock = {
  jobId?: string
  state?: string
  /** The watched condition. The tool advertises it as shown "in wake events and UI". */
  description?: string
  command?: string
  logPath?: string
}

const MONITORING_PREFIX = /^Monitoring\s+/i

/**
 * Reads a recorded `<monitor>` block. Undefined when the part carries none, so
 * the caller can fall back instead of rendering an empty block.
 */
export function parseMonitorBlock(output: string): MonitorBlock | undefined {
  const block = tagBlocks(output, "monitor")[0]
  if (!block) return undefined
  return {
    jobId: block.attrs.job || undefined,
    state: block.attrs.state || undefined,
    description: tagText(block.inner, "description") ?? stripMonitoring(tagText(block.inner, "summary")),
    command: tagText(block.inner, "command"),
    logPath: /^[^\S\n]*Full output:[^\S\n]*(\S.*?)[^\S\n]*$/m.exec(block.inner)?.[1],
  }
}

/** `<summary>Monitoring X</summary>` records the condition as prose; strip the lead-in. */
function stripMonitoring(summary: string | undefined) {
  if (!summary) return undefined
  return summary.replace(MONITORING_PREFIX, "").trim() || undefined
}