import { For, Show, createMemo } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import type { DiffCounts } from "./edit"
import { fileMeta } from "./edit"
import { DiffView } from "./diff-view"
import { ChangeMark, DiffStat, EmptyNote, PathLabel } from "./shared"

type RawPatchFile = {
  filePath?: unknown
  relativePath?: unknown
  type?: unknown
  patch?: unknown
  diff?: unknown
  before?: unknown
  after?: unknown
  additions?: unknown
  deletions?: unknown
  movePath?: unknown
}

export type MobilePatchFile = {
  path: string
  kind: "add" | "update" | "delete" | "move"
  patch?: string
  before?: string
  after?: string
  movePath?: string
  counts: DiffCounts
}

function kindOf(value: unknown): MobilePatchFile["kind"] | undefined {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
  return undefined
}

const KIND_MARK: Record<MobilePatchFile["kind"], "added" | "modified" | "deleted"> = {
  add: "added",
  update: "modified",
  delete: "deleted",
  move: "modified",
}

export function patchFilesOf(part: ToolPart): MobilePatchFile[] {
  const raw = fileMeta(part).files
  if (!Array.isArray(raw)) return []
  const out: MobilePatchFile[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const value = item as RawPatchFile
    const kind = kindOf(value.type)
    const filePath = typeof value.filePath === "string" ? value.filePath : typeof value.relativePath === "string" ? value.relativePath : undefined
    if (!kind || !filePath) continue
    const str = (v: unknown) => (typeof v === "string" ? v : undefined)
    out.push({
      path: filePath,
      kind,
      patch: str(value.patch) ?? str(value.diff),
      before: str(value.before),
      after: str(value.after),
      movePath: str(value.movePath),
      counts: {
        additions: typeof value.additions === "number" ? value.additions : 0,
        deletions: typeof value.deletions === "number" ? value.deletions : 0,
      },
    })
  }
  return out
}

export function PatchToolBody(props: { part: ToolPart }) {
  const files = createMemo(() => patchFilesOf(props.part))
  return (
    <div class="patch-body">
      <Show when={files().length > 0} fallback={<EmptyNote>No structured patch data was recorded.</EmptyNote>}>
        <For each={files()}>
          {(file) => (
            <div class="patch-file">
              <div class="patch-file-head">
                <ChangeMark status={KIND_MARK[file.kind]} />
                <PathLabel path={file.path} class="grow" />
                <Show when={file.movePath}>
                  <span class="patch-move">→</span>
                  <PathLabel path={file.movePath!} class="dim" />
                </Show>
                <DiffStat additions={file.counts.additions} deletions={file.counts.deletions} compact />
              </div>
              <DiffView patch={file.patch} before={file.before} after={file.after} maxHeightPx={220} />
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
