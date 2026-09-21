import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { ProjectInspection } from "@/project/inspection"
import { ExchangeError } from "./error"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500

export type Action = "summary" | "structure" | "recent"

export interface Input {
  readonly root: string
  readonly scope: string
  readonly displayPath: string
  readonly rootLabel: string
  readonly action?: Action
  readonly depth?: number
  readonly maxEntries?: number
  readonly recent?: number
  readonly signal?: AbortSignal
  readonly projectionMarker?: string
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface Hooks<E> {
  readonly revalidate: () => Effect.Effect<unknown, E>
}

const escape = ProjectInspection.escapeXml

function stackXml(inspection: ProjectInspection.Inspection) {
  const stack = inspection.stack
  const attrs = [`ecosystem="${escape(stack?.ecosystem ?? "unknown")}"`]
  if (stack?.monorepo) attrs.push('monorepo="true"')
  if (stack?.packageManager) attrs.push(`packageManager="${escape(stack.packageManager)}"`)
  if (inspection.lockfile) attrs.push(`lockfile="${escape(inspection.lockfile)}"`)
  const lines = [`<stack ${attrs.join(" ")}>`]
  for (const framework of stack?.frameworks ?? []) lines.push(`  <framework name="${escape(framework)}" />`)
  if (inspection.entryPoints.length) lines.push(`  <entry points="${escape(inspection.entryPoints.slice(0, 5).join(", "))}" />`)
  if (stack?.runtimeVersion) {
    lines.push(`  <version kind="${escape(stack.versionKind ?? "runtime")}" value="${escape(stack.runtimeVersion)}" />`)
  }
  for (const [name, value] of inspection.versionPins) {
    lines.push(`  <version kind="${escape(name)}" value="${escape(value)}" />`)
  }
  if (!stack) lines.push("  <hint>no recognized project manifest detected</hint>")
  for (const note of inspection.notes) lines.push(`  <note>${escape(note)}</note>`)
  for (const note of stack?.notes ?? []) lines.push(`  <note>${escape(note)}</note>`)
  lines.push("</stack>")
  return lines.join("\n")
}

function initXml(inspection: ProjectInspection.Inspection) {
  const categories = ["dev", "build", "test", "lint", "typecheck"]
  const lines = [
    `<init manifest="${inspection.stack ? "true" : "false"}" lockfile="${inspection.lockfile ? "true" : "false"}">`,
  ]
  for (const category of categories) {
    if (inspection.scripts?.some((script) => script.category === category)) lines.push(`  <script name="${category}" />`)
  }
  lines.push("</init>")
  return lines.join("\n")
}

function scriptsSummary(inspection: ProjectInspection.Inspection) {
  if (!inspection.scripts?.length) return ""
  const seen = new Set<string>()
  return inspection.scripts
    .filter((script) => {
      if (seen.has(script.category)) return false
      seen.add(script.category)
      return true
    })
    .slice(0, 5)
    .map((script) => `${escape(script.name)} → ${escape(script.cmd.length > 80 ? `${script.cmd.slice(0, 80)}…` : script.cmd)}`)
    .join("\n")
}

function summary(inspection: ProjectInspection.Inspection) {
  return [
    stackXml(inspection),
    initXml(inspection),
    inspection.entryPoints.length ? `<entry>${inspection.entryPoints.slice(0, 5).map(escape).join(", ")}</entry>` : "",
    inspection.ci.length ? `<ci>${inspection.ci.map((item) => `${escape(item.kind)} (${escape(item.path)})`).join(" · ")}</ci>` : "",
    inspection.scripts?.length ? `<scripts-summary>${scriptsSummary(inspection)}</scripts-summary>` : "",
    `<stats files="${inspection.stats.files}" totalBytes="${ProjectInspection.humanSize(inspection.stats.totalBytes)}" />`,
  ]
    .filter(Boolean)
    .join("\n")
}

function structure(inspection: ProjectInspection.Inspection, input: Input) {
  const tree = ProjectInspection.tree(inspection.files, inspection.sizes, input.depth, input.maxEntries)
  return {
    output: [
      stackXml(inspection),
      initXml(inspection),
      `<tree depth="${Math.min(Math.max(input.depth ?? ProjectInspection.DEFAULT_TREE_DEPTH, 1), ProjectInspection.MAX_TREE_DEPTH)}" entries="${tree.entries}" totalFiles="${tree.totalFiles}" totalBytes="${ProjectInspection.humanSize(tree.totalBytes)}">`,
      ...tree.lines.map(escape),
      "</tree>",
      `<stats files="${inspection.stats.files}" totalBytes="${ProjectInspection.humanSize(inspection.stats.totalBytes)}" />`,
    ].join("\n"),
    treeTruncated: tree.truncated,
  }
}

function mapInspectionError(error: ProjectInspection.InvalidInput | Ripgrep.Error): ExchangeError.Error {
  if (error instanceof ProjectInspection.InvalidInput) {
    return new ExchangeError.InvalidArgument({ detail: error.message.slice(0, 1024) })
  }
  if (error.cause instanceof globalThis.Error && error.cause.name === "AbortError") {
    return new ExchangeError.Cancelled({ detail: "Project inspection was cancelled" })
  }
  return new ExchangeError.DependencyUnavailable({ detail: "Project inspection is unavailable" })
}

export function execute<E>(ripgrep: Ripgrep.Interface, input: Input, hooks: Hooks<E>): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    const action = input.action ?? "summary"
    const abort = input.signal ?? AbortSignal.any([])
    const inspection = yield* ProjectInspection.inspect(ripgrep, { root: input.root, scope: input.scope, signal: abort }).pipe(
      Effect.mapError(mapInspectionError),
    )

    let output: string
    let producerTruncated = inspection.listTruncated
    if (action === "recent") {
      const rows = yield* ProjectInspection.recent(
        inspection.scope,
        inspection.files,
        input.recent ?? ProjectInspection.DEFAULT_RECENT,
        abort,
      )
      const now = Date.now()
      const lines = [`<recent count="${rows.length}" total="${inspection.files.length}">`]
      for (const row of rows) lines.push(`  <file path="${escape(row.path)}" modified="${ProjectInspection.relativeTime(now - row.mtime)}" />`)
      if (!rows.length) lines.push("  <note>no files found</note>")
      lines.push("</recent>")
      output = lines.join("\n")
      producerTruncated ||= rows.length < inspection.files.length
    } else if (action === "structure") {
      const rendered = structure(inspection, input)
      output = rendered.output
      producerTruncated ||= rendered.treeTruncated
    } else {
      output = summary(inspection)
    }

    yield* hooks.revalidate().pipe(Effect.asVoid)
    const projected = ToolOutputProjection.project(output, {
      maxLines: OUTPUT_LINES,
      maxBytes: OUTPUT_BYTES,
      strategy: "head",
      marker: input.projectionMarker ?? "<note>Project output truncated; narrow the project path or request</note>",
    })
    return {
      title: input.displayPath,
      output: projected.content,
      metadata: {
        action,
        root: input.rootLabel,
        files: inspection.stats.files,
        producerTruncated,
        projectionTruncated: projected.truncated,
        truncated: producerTruncated || projected.truncated,
      },
    }
  })
}

export * as ExchangeProject from "./project"
