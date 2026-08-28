import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"
import { For, Show, createMemo, createSignal } from "solid-js"
import { fileDir, fileName } from "../format"
import { IconChevronLeft, IconFileEdit, IconMinus, IconPlus } from "../icons"
import { Sheet } from "./Sheet"

function statusMark(status?: string) {
  if (status === "added") return { cls: "added", label: "A" }
  if (status === "deleted") return { cls: "deleted", label: "D" }
  return { cls: "modified", label: "M" }
}

function DiffContent(props: { patch: string }) {
  const lines = createMemo(() => props.patch.split("\n"))
  return (
    <div>
      <For each={lines()}>
        {(line) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++")
          const isDel = line.startsWith("-") && !line.startsWith("---")
          const isHunk = line.startsWith("@@")
          return (
            <div
              style={{
                display: "flex",
                padding: "1px 12px",
                background: isAdd ? "rgba(74,222,128,0.08)" : isDel ? "rgba(248,113,113,0.08)" : isHunk ? "rgba(91,141,255,0.05)" : "transparent",
                color: isAdd ? "#86efac" : isDel ? "#fca5a5" : isHunk ? "var(--accent-blue)" : "var(--text-muted)",
                "font-size": "var(--font-xs)",
                "white-space": "pre-wrap",
                "word-break": "break-all",
                "line-height": "1.5",
              }}
            >
              {line || " "}
            </div>
          )
        }}
      </For>
    </div>
  )
}

export function DiffViewer(props: { open: boolean; onClose: () => void; diffs: SnapshotFileDiff[] }) {
  const [inspected, setInspected] = createSignal<SnapshotFileDiff | undefined>()
  const totalAdd = createMemo(() => props.diffs.reduce((sum, f) => sum + f.additions, 0))
  const totalDel = createMemo(() => props.diffs.reduce((sum, f) => sum + f.deletions, 0))

  return (
    <Sheet open={props.open} onClose={() => { setInspected(undefined); props.onClose() }} title={inspected() ? undefined : "Changes"} height="full">
      <Show
        when={!inspected()}
        fallback={
          <div>
            <div class="diff-detail-head">
              <button onClick={() => setInspected(undefined)}>
                <IconChevronLeft size={11} />
                Changes
              </button>
              <span class="path">{inspected() ? fileName(inspected()!.file ?? "") : ""}</span>
              <span style={{ "font-size": "var(--font-xs)", color: "var(--accent-green)" }}>+{inspected()?.additions}</span>
              <span style={{ "font-size": "var(--font-xs)", color: "var(--accent-red)" }}>−{inspected()?.deletions}</span>
            </div>
            <Show when={inspected()?.patch} fallback={<div class="diff-detail-empty">No patch content available</div>}>
              <DiffContent patch={inspected()!.patch!} />
            </Show>
          </div>
        }
      >
        <div class="diff-summary-bar">
          <span class="files"><IconFileEdit size={11} />{props.diffs.length} files</span>
          <span class="add"><IconPlus size={9} />{totalAdd()}</span>
          <span class="del"><IconMinus size={9} />{totalDel()}</span>
          <div class="diff-stat-track">
            <div style={{ height: "100%", background: "rgba(74,222,128,0.6)", width: `${totalAdd() + totalDel() > 0 ? (totalAdd() / (totalAdd() + totalDel())) * 100 : 0}%` }} />
            <div style={{ height: "100%", background: "rgba(248,113,113,0.6)", width: `${totalAdd() + totalDel() > 0 ? (totalDel() / (totalAdd() + totalDel())) * 100 : 0}%` }} />
          </div>
        </div>
        <For each={props.diffs}>
          {(diff) => {
            const mark = statusMark(diff.status)
            const path = diff.file ?? ""
            return (
              <button class="file-row" onClick={() => setInspected(diff)}>
                <span class={`file-status-mark ${mark.cls}`}>{mark.label}</span>
                <span class="file-row-name">
                  <span class="dir">{fileDir(path)}</span>
                  <span class="base">{fileName(path)}</span>
                </span>
                <span class="file-row-stats">
                  <Show when={diff.additions > 0}><span class="add">+{diff.additions}</span></Show>
                  <Show when={diff.deletions > 0}><span class="del">−{diff.deletions}</span></Show>
                </span>
              </button>
            )
          }}
        </For>
      </Show>
    </Sheet>
  )
}
