import { Accordion } from "@opencode-ai/ui/accordion"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import type { Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import { For, Show, createMemo } from "solid-js"
import { formatDuration } from "../format"

import {
  IconAlertTriangle,
  IconCheckCircle,
  IconChevronRight,
  IconClock,
  IconWrench,
  IconXCircle,
} from "../icons"
import type { KillShellFn } from "./tools/registry"
import { labelFor, resolveDescriptor } from "./tools/registry"
import { StopButton } from "./tools/shell"

function genericDetail(part: ToolPart): string {
  const state = part.state
  const input = state.input as Record<string, unknown> | undefined
  if (input) {
    const candidate = input.filePath ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description
    if (typeof candidate === "string" && candidate) return candidate
  }
  return ""
}

const STATUS_ICON: Record<string, Component<{ size?: number }>> = {
  pending: IconClock,
  completed: IconCheckCircle,
  error: IconXCircle,
}

export function ToolCallRow(props: {
  part: ToolPart
  expanded: boolean
  onToggle: () => void
  killShell?: KillShellFn
}) {
  const part = () => props.part
  const status = () => part().state.status
  const expanded = () => props.expanded
  const { descriptor } = resolveDescriptor(part().tool)
  const primary = resolveDescriptor(part().tool).name

  const description = createMemo(() => {
    const custom = descriptor?.detail?.(part())
    return custom ?? genericDetail(part())
  })

  const hasCustomBody = () => !!descriptor?.body
  const expandable = () => !descriptor?.hideDetails

  const errorText = () => (status() === "error" ? ((part().state as { error?: string }).error ?? "") : "")

  const outputText = () => {
    const state = part().state as { output?: string }
    return status() === "completed" || status() === "error" ? state.output ?? "" : ""
  }

  const inputJSON = () => {
    const raw = part().state.input as Record<string, unknown> | undefined
    if (!raw || Object.keys(raw).length === 0) return undefined
    return JSON.stringify(raw, null, 2)
  }

  const genericContent = () => expandable() && !hasCustomBody()

  const duration = createMemo(() => {
    const s = part().state
    if ((s.status === "completed" || s.status === "error") && "time" in s) {
      const ms = s.time.end - s.time.start
      return ms > 0 ? ms : undefined
    }
    return undefined
  })

  // Live stop control: foreground tool calls stop via callID, background jobs via jobId.
  const canStop = () => {
    if (primary !== "shell") return false
    if (!props.killShell) return false
    if (status() !== "running") return false
    return true
  }

  const stopPayload = () => {
    const meta = (part().state as { metadata?: Record<string, unknown> }).metadata ?? {}
    const jobId = typeof meta.jobId === "string" ? meta.jobId : undefined
    return jobId ? { sessionID: part().sessionID, jobId } : { sessionID: part().sessionID, callID: part().callID }
  }

  const handleStop = async () => {
    if (!props.killShell) return false
    try {
      const result = await props.killShell(stopPayload())
      return !!result?.killed
    } catch {
      return false
    }
  }

  // Some tools stay invisible until they resolve (e.g. unanswered questions are
  // surfaced by the permission/question dock instead of an inline row).
  const visible = () => !descriptor?.shouldRender || descriptor.shouldRender(part())

  return (
    <Show when={visible()}>
      <Accordion
      class={`tool-row ${status()} tool-${primary}`}
      multiple
      collapsible
      value={expanded() ? ["body"] : []}
      onChange={(value) => value.includes("body") !== expanded() && props.onToggle()}
    >
      <Accordion.Item value="body">
        <Accordion.Header>
          <Accordion.Trigger class="tool-row-head">
            <span class="tool-status-icon">
              <Show when={status() === "running"}>
                <span class="status-dot blue pulse" />
              </Show>
              <Show when={status() !== "running"}>
                <Dynamic component={STATUS_ICON[status()] ?? IconCheckCircle} size={11} />
              </Show>
            </span>
            <span class="tool-type-icon">
              <Dynamic component={descriptor?.icon ?? IconWrench} size={11} />
            </span>
            <span class="tool-label">{descriptor ? descriptor.title(part()) : labelFor(part().tool)}</span>
            <span class="tool-detail">{description()}</span>
            <span class="tool-meta">
              <Show when={descriptor?.meta}>
                {(meta) => <Dynamic component={meta()} part={part()} killShell={props.killShell} />}
              </Show>
              <Show when={duration() !== undefined}>
                <span class="tool-duration tnum">{formatDuration(duration()!)}</span>
              </Show>
              <Show when={canStop()}>
                <StopButton running={() => status() === "running"} onStop={handleStop} />
              </Show>
              <Show when={expandable() && (!!inputJSON() || !!outputText() || hasCustomBody())}>
                <IconChevronRight size={10} class={`tool-chevron ${expanded() ? "open" : ""}`} />
              </Show>
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content class="tool-body-content">
          <div class="tool-body">
            <Show when={errorText()}>
              <div class="tool-error-box">
                <div class="tool-body-label"><IconAlertTriangle size={9} /><span>Error</span></div>
                <pre class="tool-output-pre error">{errorText()}</pre>
              </div>
            </Show>
            <Show when={descriptor?.body}>
              {(body) => <Dynamic component={body()} part={part()} killShell={props.killShell} />}
            </Show>
            <Show when={genericContent()}>
              <Show when={inputJSON()} keyed>
                {(json) => (
                  <div class="tool-section">
                    <div class="tool-section-head"><span class="tool-section-label">Input</span></div>
                    <pre class="tool-output-pre">{json}</pre>
                  </div>
                )}
              </Show>
              <Show when={outputText()} keyed>
                {(out) => (
                  <div class="tool-section">
                    <div class="tool-section-head"><span class="tool-section-label">{errorText() ? "Error" : "Output"}</span></div>
                    <pre class="tool-output-pre">{out}</pre>
                  </div>
                )}
              </Show>
            </Show>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion>
    </Show>
  )
}

export function ToolCallGroup(props: {
  parts: ToolPart[]
  expandedParts: ReadonlySet<string>
  onTogglePart: (id: string) => void
  killShell?: KillShellFn
}) {
  const running = createMemo(() => props.parts.filter((t) => t.state.status === "running").length)
  const failed = createMemo(() => props.parts.filter((t) => t.state.status === "error").length)
  const ok = createMemo(() => props.parts.filter((t) => t.state.status === "completed").length)

  return (
    <div class="tool-group">
      <Show when={props.parts.length >= 3}>
        <div class="tool-group-summary">
          <span>{props.parts.length} calls</span>
          <Show when={ok() > 0}><span class="ok">{ok()} done</span></Show>
          <Show when={failed() > 0}><span class="fail">{failed()} failed</span></Show>
          <Show when={running() > 0}><span class="run">{running()} running</span></Show>
        </div>
      </Show>
      <For each={props.parts}>{(part) => (
        <ToolCallRow
          part={part}
          expanded={props.expandedParts.has(part.id)}
          onToggle={() => props.onTogglePart(part.id)}
          killShell={props.killShell}
        />
      )}</For>
    </div>
  )
}

