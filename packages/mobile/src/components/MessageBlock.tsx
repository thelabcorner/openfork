import type { AssistantMessage, Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import type { KillShellFn } from "./tools/registry"
import { Index, Show, createMemo, createSignal } from "solid-js"
import { formatCost, formatDuration, formatTokens, shortModel } from "../format"
import { Markdown } from "./Markdown"
import { ProviderBadge } from "./ProviderBadge"
import { TensorSpinner } from "./SessionStatus"
import { ToolCallGroup } from "./ToolCallRow"
import {
  IconAlertTriangle,
  IconBot,
  IconBrain,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFileEdit,
  IconInfo,
} from "../icons"

type Segment = { kind: "tools"; parts: ToolPart[] } | { kind: "part"; part: Part }

function segmentParts(parts: Part[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    if (part.type === "tool") {
      const last = segments[segments.length - 1]
      if (last && last.kind === "tools") {
        last.parts.push(part)
        continue
      }
      segments.push({ kind: "tools", parts: [part] })
      continue
    }
    if (part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot") continue
    segments.push({ kind: "part", part })
  }
  return segments
}

function ReasoningBlock(props: { id: string; text: string; streaming: boolean; expanded: boolean; onToggle: () => void }) {
  const expanded = () => props.streaming || props.expanded
  const lines = createMemo(() => (props.text ? props.text.split("\n").length : 0))
  const hasText = () => props.text.trim().length > 0
  return (
    <div class="segment-block">
      <button class="msg-reasoning-toggle" onClick={props.onToggle}>
        <IconBrain size={11} />
        <span class="label">Reasoning</span>
        {expanded() ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
        <Show when={hasText()}><span class="lines">{lines()} lines</span></Show>
        <Show when={props.streaming && !hasText()}><span class="lines reasoning-live">thinking…</span></Show>
      </button>
      <Show when={expanded()}>
        <div class="msg-reasoning-body">
          <Show when={hasText()} fallback={<div class="reasoning-shimmer"><span class="dot" /><span class="dot" /><span class="dot" /></div>}>
            <Markdown text={props.text} streaming={props.streaming} />
          </Show>
        </div>
      </Show>
    </div>
  )
}

// Segments render inside .assistant-body, which already sits inside the
// outer message row's horizontal padding — these must NOT add their own
// left/right padding (that previously double-indented reasoning/tool/subtask
// blocks relative to the plain assistant-text segments next to them).
function SegmentBlock(props: {
  segment: Segment
  streaming: boolean
  expandedParts: ReadonlySet<string>
  onTogglePart: (id: string) => void
  killShell?: KillShellFn
}) {
  const segment = () => props.segment
  if (segment().kind === "tools") {
    return (
      <div class="segment-block">
        <ToolCallGroup parts={(segment() as Extract<Segment, { kind: "tools" }>).parts} expandedParts={props.expandedParts} onTogglePart={props.onTogglePart} killShell={props.killShell} />
      </div>
    )
  }
  const part = () => (segment() as Extract<Segment, { kind: "part" }>).part
  if (part().type === "text") {
    return (
      <Show when={(part() as Extract<Part, { type: "text" }>).text.trim()}>
        <div class="assistant-text">
          <Markdown text={(part() as Extract<Part, { type: "text" }>).text} streaming={props.streaming} />
          <Show when={props.streaming}><span class="stream-caret" aria-hidden="true" /></Show>
        </div>
      </Show>
    )
  }
  if (part().type === "reasoning") {
    const reasoning = () => part() as Extract<Part, { type: "reasoning" }>
    return (
      <ReasoningBlock
        id={reasoning().id}
        text={reasoning().text}
        streaming={props.streaming}
        expanded={props.expandedParts.has(reasoning().id)}
        onToggle={() => props.onTogglePart(reasoning().id)}
      />
    )
  }
  if (part().type === "subtask") {
    const subtask = () => part() as Extract<Part, { type: "subtask" }>
    return (
      <div class="segment-block">
        <div class="msg-subtask">
          <IconBot size={11} />
          <span class="agent-name">{subtask().agent}</span>
          <span class="desc">{subtask().description}</span>
        </div>
      </div>
    )
  }
  if (part().type === "patch") {
    const patch = () => part() as Extract<Part, { type: "patch" }>
    return (
      <div class="segment-block">
        <div class="msg-patch">
          <IconFileEdit size={11} />
          <span>{patch().files.length} file{patch().files.length === 1 ? "" : "s"} changed</span>
        </div>
      </div>
    )
  }
  if (part().type === "retry") {
    const retry = () => part() as Extract<Part, { type: "retry" }>
    return (
      <div class="segment-block">
        <div class="msg-retry">
          <IconAlertTriangle size={11} />
          <span>Retry {retry().attempt} — {retry().error.data.message}</span>
        </div>
      </div>
    )
  }
  if (part().type === "compaction") {
    const compaction = () => part() as Extract<Part, { type: "compaction" }>
    return (
      <div class="segment-block">
        <div class="msg-compaction">
          <IconInfo size={10} />
          <span>{compaction().auto ? "Auto-compacted" : "Compacted"} conversation history</span>
        </div>
      </div>
    )
  }
  return null
}

export function MessageGroup(props: {
  info: Message
  parts: Part[]
  isLast: boolean
  expandedParts: ReadonlySet<string>
  onTogglePart: (id: string) => void
  killShell?: KillShellFn
}) {
  const [showActions, setShowActions] = createSignal(false)
  const segments = createMemo(() => segmentParts(props.parts))

  if (props.info.role === "user") {
    const text = createMemo(() =>
      props.parts
        .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n\n"),
    )
    return (
      <div
        class="msg-block msg-user-row"
        onContextMenu={(e) => {
          e.preventDefault()
          setShowActions((v) => !v)
        }}
      >
        <div class="msg-user-bubble-wrap">
          <div class="msg-user-bubble">
            <p>{text()}</p>
          </div>
          <Show when={showActions()}>
            <div class="msg-user-actions">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(text())
                  setShowActions(false)
                }}
              >
                <IconCopy size={12} />
              </button>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  const assistant = () => props.info as AssistantMessage
  const isStreaming = createMemo(() => props.isLast && !assistant().time.completed)
  const totalTokens = createMemo(() => {
    const t = assistant().tokens
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  })
  const duration = createMemo(() =>
    assistant().time.completed ? (assistant().time.completed as number) - assistant().time.created : undefined,
  )

  return (
    <>
      <div class="msg-block msg-assistant-row">
        <div class="assistant-avatar">
          <ProviderBadge providerID={assistant().providerID} />
        </div>
        <div class="assistant-body">
          <div class="assistant-model-row">
            <span class="model-name">{shortModel(assistant().modelID)}</span>
            <Show when={isStreaming()}><TensorSpinner size={11} /></Show>
          </div>
          <Index each={segments()}>
            {(segment, index) => (
              <SegmentBlock
                segment={segment()}
                streaming={isStreaming() && index === segments().length - 1}
                expandedParts={props.expandedParts}
                onTogglePart={props.onTogglePart}
                killShell={props.killShell}
              />
            )}
          </Index>
          <Show when={!isStreaming() && (totalTokens() > 0 || assistant().cost > 0)}>
            <div class="assistant-meta">
              <Show when={totalTokens() > 0}><span class="tnum">{formatTokens(totalTokens())} tok</span></Show>
              <Show when={assistant().cost > 0}><span class="tnum">{formatCost(assistant().cost)}</span></Show>
              <Show when={duration() !== undefined}><span class="tnum">{formatDuration(duration()!)}</span></Show>
            </div>
          </Show>
        </div>
      </div>
      <Show when={assistant().error}>
        <div class="msg-block">
          <div class="msg-error-box">
            <IconAlertTriangle size={13} />
            <div>
              <p class="title">{assistant().error!.name}</p>
              <p class="body">{errorMessage(assistant().error)}</p>
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}

function errorMessage(error: AssistantMessage["error"]): string {
  const data = (error?.data as { message?: string } | undefined)
  return data?.message ?? "Unknown error"
}
