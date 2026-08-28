import type { Session } from "@opencode-ai/sdk/v2/client"
import { Show, createMemo, createSignal } from "solid-js"
import { formatCost, formatDuration, formatRelativeTime, shortModel } from "../format"
import { IconHelpCircle, IconShield } from "../icons"
import { ProviderBadge } from "./ProviderBadge"
import type { RuntimeStatus } from "./SessionStatus"
import { TensorSpinner } from "./SessionStatus"

export type SessionRuntime = {
  status: RuntimeStatus
  permissions: number
  questions: number
  busySince?: number
}

export function sessionMeta(session: Session) {
  const tokens = session.tokens
  const input = tokens?.input ?? 0
  const output = tokens?.output ?? 0
  const reasoning = tokens?.reasoning ?? 0
  const cacheRead = tokens?.cache?.read ?? 0
  const cacheWrite = tokens?.cache?.write ?? 0
  const contextUsed = input + cacheRead + cacheWrite
  const cacheHitPct = contextUsed > 0 ? Math.round((cacheRead / contextUsed) * 100) : null
  const totalTokens = input + output + reasoning + cacheRead + cacheWrite
  return { cacheHitPct, totalTokens }
}

function contextTier(pct: number) {
  if (pct >= 85) return "critical"
  if (pct >= 65) return "warn"
  if (pct >= 40) return "mid"
  return "low"
}

export function SessionRow(props: {
  session: Session
  active: boolean
  runtime: SessionRuntime
  contextPct?: number
  onSelect: () => void
  onContextMenu: () => void
}) {
  const [pressed, setPressed] = createSignal(false)
  const meta = createMemo(() => sessionMeta(props.session))
  const isGenerating = () => props.runtime.status === "generating"
  const isRetrying = () => props.runtime.status === "retry"
  const isWaiting = () => props.runtime.status === "waiting_permission" || props.runtime.status === "waiting_question"
  const hasError = () => props.runtime.status === "error"

  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  const startLongPress = () => {
    setPressed(true)
    longPressTimer = setTimeout(() => {
      props.onContextMenu()
      setPressed(false)
    }, 480)
  }
  const cancelLongPress = () => {
    setPressed(false)
    if (longPressTimer) clearTimeout(longPressTimer)
  }

  return (
    <button
      class={`session-row ${props.active ? "active" : ""} ${pressed() ? "pressed" : ""}`}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onClick={props.onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu()
      }}
    >
      <div class="session-row-inner">
        <div class="row-top">
          <span class="row-status-mark">
            <Show
              when={isGenerating()}
              fallback={
                <Show
                   when={hasError() || isWaiting() || isRetrying()}
                  fallback={<span class="status-ring" />}
                >
                  <span class={`status-dot ${hasError() ? "error" : "amber pulse"}`} />
                </Show>
              }
            >
              <TensorSpinner size={13} />
            </Show>
          </span>
          <span class={`row-title ${hasError() ? "error" : ""}`}>{props.session.title || "Untitled session"}</span>
          <Show when={props.runtime.permissions > 0}>
            <span class="row-pill amber">
              <IconShield size={9} />
              {props.runtime.permissions}
            </span>
          </Show>
          <Show when={props.runtime.questions > 0}>
            <span class="row-pill blue">
              <IconHelpCircle size={9} />
              {props.runtime.questions}
            </span>
          </Show>
          <span class="row-time tnum">{formatRelativeTime(props.session.time.updated)}</span>
        </div>

        <div class="row-bottom">
          <Show when={props.contextPct !== undefined}>
            <span class="ctx-wrap">
              <span class="mini-bar-track ctx-track">
                <span
                  class={`mini-bar-fill ctx-fill-${contextTier(props.contextPct!)}`}
                  style={{ width: `${Math.max(props.contextPct!, 2)}%` }}
                />
              </span>
              <span class={`ctx-pct tnum ctx-${contextTier(props.contextPct!)}`}>{props.contextPct}%</span>
            </span>
          </Show>
          <Show when={(props.session.cost ?? 0) > 0}>
            <span class="row-meta-val tnum">{formatCost(props.session.cost!)}</span>
          </Show>
          <Show when={meta().cacheHitPct !== null}>
            <span class="row-meta-val tnum faint">{meta().cacheHitPct}% cache</span>
          </Show>
          <Show when={props.session.model}>
            <span class="row-model">
              <ProviderBadge providerID={props.session.model!.providerID} />
              <span class="row-model-name">
                {shortModel(props.session.model!.id)}
                <Show when={props.session.model!.variant}> · {props.session.model!.variant}</Show>
              </span>
            </span>
          </Show>
          <span class="spacer" />
          <Show
            when={isGenerating()}
            fallback={
              <Show when={props.session.summary && props.session.summary.files > 0}>
                <span class="row-meta-val tnum faint">{props.session.summary!.files} changed</span>
              </Show>
            }
          >
            <span class="row-live tnum">
              {props.runtime.busySince ? formatDuration(Date.now() - props.runtime.busySince) : "generating"}
            </span>
          </Show>
        </div>
      </div>
    </button>
  )
}
