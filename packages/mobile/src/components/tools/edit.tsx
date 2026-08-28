import { Show, createMemo } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { parseUnifiedDiff, synthesizeDiff } from "./diff"
import { DiffView } from "./diff-view"
import {
  CappedCode,
  DiffStat,
  EmptyNote,
  PathLabel,
  Section,
  inputString,
} from "./shared"

type FileDiffMeta = {
  file?: unknown
  patch?: unknown
  before?: unknown
  after?: unknown
}

export type DiffCounts = { additions: number; deletions: number }

export function fileMeta(part: ToolPart): Record<string, unknown> {
  return ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
}

export function fileDiffOf(part: ToolPart): { path: string; patch?: string; before?: string; after?: string } | undefined {
  const filediff = fileMeta(part).filediff as FileDiffMeta | undefined
  if (!filediff) return undefined
  const str = (value: unknown) => (typeof value === "string" ? value : undefined)
  const path = str(filediff.file) || inputString(part, "filePath", "path") || ""
  return { path, patch: str(filediff.patch), before: str(filediff.before), after: str(filediff.after) }
}

// Cheap +/- counts for the collapsed head chip from whatever source exists.
export function diffCounts(part: ToolPart): DiffCounts | undefined {
  const meta = fileMeta(part)
  const add = typeof meta.additions === "number" ? meta.additions : undefined
  const del = typeof meta.deletions === "number" ? meta.deletions : undefined
  if (add !== undefined || del !== undefined) return { additions: add ?? 0, deletions: del ?? 0 }
  const source = fileDiffOf(part)
  if (!source) return undefined
  if (source.patch) {
    const parsed = parseUnifiedDiff(source.patch)
    if (parsed) return parsed
  }
  if (source.before !== undefined || source.after !== undefined) {
    const synthesized = synthesizeDiff(source.before ?? "", source.after ?? "")
    if (synthesized) return { additions: synthesized.additions, deletions: synthesized.deletions }
  }
  return undefined
}

export function HeadDiffStat(props: { part: ToolPart }) {
  const counts = createMemo(() => diffCounts(props.part))
  return <Show when={counts()}>{(c) => <DiffStat additions={c().additions} deletions={c().deletions} />}</Show>
}

export function EditToolBody(props: { part: ToolPart }) {
  const source = createMemo(() => fileDiffOf(props.part))
  const headPath = createMemo(() => inputString(props.part, "filePath", "path") ?? "")
  const oldString = createMemo(() => inputString(props.part, "oldString"))
  const hasDiffSource = createMemo(() => !!source()?.patch || source()?.before !== undefined)

  return (
    <div class="edit-body">
      <Show when={hasDiffSource()} fallback={<ReplacementFallback part={props.part} />}>
        <Section label="Changes" action={<Show when={headPath()}><PathLabel path={headPath()} /></Show>}>
          <DiffView patch={source()!.patch} before={source()!.before} after={source()!.after} />
        </Section>
      </Show>
      <Show when={oldString()}>
        {(text) => (
          <Section label="Matched snippet">
            <CappedCode text={text} class="tool-json-block dimmed" />
          </Section>
        )}
      </Show>
    </div>
  )
}

function ReplacementFallback(props: { part: ToolPart }) {
  const replacement = createMemo(() => {
    const after = inputString(props.part, "newString")
    return after !== undefined && after.trim().length > 0 ? after : undefined
  })
  return (
    <Show when={replacement()} fallback={<EmptyNote>No structured diff was recorded for this edit.</EmptyNote>}>
      {(text) => (
        <Section label="New content">
          <CappedCode text={() => text()} class="tool-json-block add-tint" />
        </Section>
      )}
    </Show>
  )
}

export function WriteToolBody(props: { part: ToolPart }) {
  const path = createMemo(() => inputString(props.part, "filePath", "path") ?? "")
  const shown = createMemo(() => {
    const inline = inputString(props.part, "content")
    if (inline) return inline
    const filediff = fileMeta(props.part).filediff as FileDiffMeta | undefined
    const after = filediff && typeof filediff.after === "string" ? filediff.after : undefined
    return after && after.trim() ? after : undefined
  })
  return (
    <div class="write-body">
      <Show when={shown()} fallback={<EmptyNote>The written content is not included in this tool call.</EmptyNote>}>
        {(text) => (
          <Section label="Written file" action={<Show when={path()}><PathLabel path={path()} /></Show>}>
            <DiffView before="" after={text()} />
          </Section>
        )}
      </Show>
    </div>
  )
}
