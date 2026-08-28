import { For, Show, createSignal } from "solid-js"
import { ProviderBadge } from "../components/ProviderBadge"
import { IconChevronDown, IconRefresh } from "../icons"
import { formatRelativeTime } from "../format"
import {
  displayWindowLabel,
  formatCountdownSeconds,
  formatPercent,
  resolveTierGate,
  sortWindows,
  tierGateState,
  toneForRemaining,
  worstRemainingFromWindows,
  type ProviderResult,
  type Tone,
  type UsageWindow,
} from "../limits-format"

export type { ProviderResult, UsageWindow }

export type PerKeyEntry = {
  id: string
  label: string
  active: boolean
  windows: [string, UsageWindow][]
}

export type LimitsProviderData = {
  result: ProviderResult
  perKey?: PerKeyEntry[]
}

export type OpenRouterFree = {
  usedPercent: number
  remaining: number
  limit: number
}

function levelClass(tone: Tone, kind: "fill" | "text") {
  if (tone === "danger") return kind === "fill" ? "level-critical" : "level-critical-text"
  if (tone === "warning") return kind === "fill" ? "level-warn" : "level-warn-text"
  if (tone === "muted") return kind === "fill" ? "level-muted" : "level-muted-text"
  return ""
}

function windowRemaining(w: UsageWindow): number | null {
  return w.remainingPercent ?? (w.usedPercent !== null ? 100 - w.usedPercent : null)
}

function WindowRow(props: { label: string; window: UsageWindow; gateState: "binding" | "gated" | "normal" }) {
  const remaining = () => windowRemaining(props.window)
  const tone = () => toneForRemaining(remaining())
  return (
    <div class="tier-row" classList={{ dim: props.gateState === "gated" }}>
      <span class="tier-label">
        {props.label}
        <Show when={props.gateState === "binding"}><span class="badge badge-limiting">Limiting</span></Show>
      </span>
      <Show when={remaining() !== null} fallback={<span class="tier-amount" style={{ "grid-column": "span 2" }}>{props.window.valueLabel ?? "—"}</span>}>
        <div class="level-bar-track"><div class={`level-bar-fill ${levelClass(tone(), "fill")}`} style={{ width: `${Math.min(100, 100 - (remaining() ?? 0))}%` }} /></div>
        <span class={`tier-value tnum ${levelClass(tone(), "text")}`}>{formatPercent(remaining())}</span>
      </Show>
      <span class="tier-reset">{props.window.resetAfterSeconds !== null ? formatCountdownSeconds(props.window.resetAfterSeconds) : "No reset"}</span>
    </div>
  )
}

function ProviderSection(props: { data: LimitsProviderData }) {
  const [expanded, setExpanded] = createSignal(false)
  const result = () => props.data.result
  const windows = () => (result().usage ? sortWindows(Object.entries(result().usage!.windows)) : [])
  const gate = () => resolveTierGate(windows())
  const worst = () => gate().effectiveRemaining ?? worstRemainingFromWindows(windows())
  const errored = () => !result().ok && windows().length === 0

  return (
    <div class="provider-section">
      <div class="provider-header">
        <span class={`provider-dot ${errored() || (worst() !== null && worst()! <= 30) ? "" : "dim"}`} style={errored() ? { background: "var(--accent-red)" } : undefined} />
        <ProviderBadge providerID={result().providerId} size="sm" />
        <span class="provider-name">{result().providerName}</span>
        <Show when={result().planLabel}><span class="badge badge-count">{result().planLabel}</span></Show>
        <Show when={errored()}><span class="badge badge-limiting">Error</span></Show>
        <Show when={!result().configured}><span class="badge badge-count">Not configured</span></Show>
      </div>
      <Show when={windows().length > 0} fallback={<div class="tier-row"><span class="tier-label">No usage data</span></div>}>
        <For each={windows()}>
          {([key, w]) => <WindowRow label={displayWindowLabel(key)} window={w} gateState={tierGateState(key, windowRemaining(w), gate())} />}
        </For>
      </Show>
      <Show when={props.data.perKey && props.data.perKey.length > 0}>
        <button class={`per-key-toggle ${expanded() ? "open" : ""}`} onClick={() => setExpanded((v) => !v)}>
          <IconChevronDown size={12} />
          Per key · {props.data.perKey!.length}
        </button>
        <Show when={expanded()}>
          <div class="per-key-list">
            <For each={props.data.perKey}>
              {(key) => {
                const keyGate = () => resolveTierGate(key.windows)
                return (
                  <div class="per-key-item">
                    <div class="per-key-header">
                      <span class="key-name">{key.label}</span>
                      <Show when={key.active}><span class="badge badge-active">Active</span></Show>
                    </div>
                    <For each={key.windows}>
                      {([wkey, w]) => <WindowRow label={displayWindowLabel(wkey)} window={w} gateState={tierGateState(wkey, windowRemaining(w), keyGate())} />}
                    </For>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export function LimitsView(props: {
  providers: LimitsProviderData[]
  loading: boolean
  updatedAt?: number
  openRouterFree?: OpenRouterFree
  onRefresh: () => void
}) {
  return (
    <div class="view-root">
      <div class="sessions-header">
        <div class="sessions-titlebar">
          <div class="brand-mark">
            <span class="brand-title">Limits</span>
          </div>
          <button class="icon-btn" onClick={props.onRefresh} title="Refresh">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>
      <div class="view-scroll limits-scroll">
        <Show when={props.updatedAt}>
          <div class="limits-updated">Updated {formatRelativeTime(props.updatedAt!)}</div>
        </Show>
        <Show when={props.loading && props.providers.length === 0}>
          <p class="muted" style={{ padding: "16px 2px" }}>Loading usage data…</p>
        </Show>
        <Show when={!props.loading && props.providers.length === 0}>
          <div class="empty-list"><p>No quota providers registered</p></div>
        </Show>
        <For each={props.providers}>{(data) => <ProviderSection data={data} />}</For>
        <Show when={props.openRouterFree}>
          {(free) => (
            <div class="provider-section">
              <div class="provider-header">
                <span class="provider-dot" />
                <ProviderBadge providerID="openrouter" size="sm" />
                <span class="provider-name">OpenRouter Free Tier</span>
              </div>
              <div class="tier-row">
                <span class="tier-label">Free requests</span>
                <div class="level-bar-track"><div class={`level-bar-fill ${levelClass(toneForRemaining(100 - free().usedPercent), "fill")}`} style={{ width: `${free().usedPercent}%` }} /></div>
                <span class="tier-value tnum">{formatPercent(100 - free().usedPercent)}</span>
                <span class="tier-reset">{free().remaining} / {free().limit} left</span>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
