import type { ResultTone } from "./basic-tool"

export type ToolResult = {
  text?: string
  tone?: ResultTone
  changes?: { additions: number; deletions: number }
}

const nf = new Intl.NumberFormat()

function plural(count: number, one: string, other: string) {
  return `${nf.format(count)} ${count === 1 ? one : other}`
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Counts non-empty lines, so a trailing newline doesn't inflate the number. */
export function lineCount(output: string | undefined) {
  if (!output) return undefined
  const trimmed = output.replace(/\n+$/, "")
  return trimmed ? trimmed.split("\n").length : 0
}

/**
 * `edit` reports structured `filediff` counts, but `write` and `patch` only
 * hand back a unified diff string, so count the hunks directly for those.
 */
export function countUnifiedDiff(value: unknown) {
  if (typeof value !== "string" || !value) return undefined
  let additions = 0
  let deletions = 0
  for (const line of value.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  if (additions === 0 && deletions === 0) return undefined
  return { additions, deletions }
}

function diffChanges(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const additions = num((value as Record<string, unknown>).additions)
  const deletions = num((value as Record<string, unknown>).deletions)
  if (additions === undefined && deletions === undefined) return undefined
  return { additions: additions ?? 0, deletions: deletions ?? 0 }
}

/**
 * What the call *returned*, for the collapsed tool row. Without this you cannot
 * tell a grep that found 40 matches from one that found 0 without expanding it.
 *
 * Returns undefined when there is no trustworthy signal — an empty result slot
 * is better than a fabricated one. Only fields the tools actually emit are read
 * here; see `packages/opencode/src/tool/*.ts` for the metadata shapes.
 */
export function getToolResult(input: {
  tool: string
  args?: Record<string, any>
  metadata?: Record<string, unknown>
  output?: string
  status?: string
}): ToolResult | undefined {
  const { tool, args = {}, metadata = {}, output, status } = input
  if (status === "pending" || status === "running") return undefined
  if (status === "error") return { text: "failed", tone: "danger" }

  switch (tool) {
    case "read": {
      const lines = lineCount(output)
      if (lines === undefined) return undefined
      const label = plural(lines, "line", "lines")
      return { text: metadata.truncated ? `${label}+` : label }
    }
    case "list": {
      const entries = lineCount(output)
      return entries === undefined ? undefined : { text: plural(entries, "entry", "entries") }
    }
    case "glob": {
      const count = num(metadata.count) ?? lineCount(output)
      if (count === undefined) return undefined
      return { text: plural(count, "file", "files"), tone: count === 0 ? "warning" : undefined }
    }
    case "grep": {
      const matches = num(metadata.matches)
      if (matches === undefined) return undefined
      return { text: plural(matches, "match", "matches"), tone: matches === 0 ? "warning" : undefined }
    }
    case "edit":
    case "write":
    case "patch":
    case "apply_patch": {
      const changes = diffChanges(metadata.filediff) ?? countUnifiedDiff(metadata.diff)
      return changes ? { changes } : undefined
    }
    case "bash":
    case "shell":
    case "background": {
      const exit = num(metadata.exit)
      if (exit === undefined) return undefined
      return { text: `exit ${exit}`, tone: exit === 0 ? "success" : "danger" }
    }
    case "todowrite": {
      const todos = Array.isArray(args.todos) ? args.todos : undefined
      if (!todos?.length) return undefined
      const done = todos.filter((todo: any) => todo?.status === "completed").length
      return { text: `${done} / ${todos.length}`, tone: done === todos.length ? "success" : undefined }
    }
    case "typecheck": {
      const errors = num(metadata.errors)
      if (errors === undefined) return undefined
      return {
        text: errors === 0 ? "clean" : plural(errors, "error", "errors"),
        tone: errors === 0 ? "success" : "danger",
      }
    }
    case "sqlite": {
      const rows = num(metadata.rows)
      return rows === undefined ? undefined : { text: plural(rows, "row", "rows") }
    }
    default:
      return undefined
  }
}
