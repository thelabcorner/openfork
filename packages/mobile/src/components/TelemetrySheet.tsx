import type { Session } from "@opencode-ai/sdk/v2/client"
import { Show, createMemo } from "solid-js"
import { formatCost, formatTokens } from "../format"
import { ContextMeter } from "./ContextMeter"
import { Sheet } from "./Sheet"

function StatRow(props: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div class="stat-row">
      <span class="label">{props.label}</span>
      <span>
        <span class={`value tnum ${props.highlight ? "highlight" : ""}`}>{props.value}</span>
        <Show when={props.sub}><span class="sub">{props.sub}</span></Show>
      </span>
    </div>
  )
}

export function TelemetrySheet(props: {
  open: boolean
  onClose: () => void
  session: Session
  contextTotal: number
  messageCount: number
  toolCallCount: number
}) {
  const tokens = createMemo(() => props.session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  const cacheHitPct = createMemo(() => {
    const t = tokens()
    const denom = t.input + t.cache.read + t.cache.write
    return denom > 0 ? Math.round((t.cache.read / denom) * 100) : 0
  })
  const total = createMemo(() => {
    const t = tokens()
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  })

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Session Telemetry" height="full">
      <div style={{ "padding-top": "10px" }}>
        <section class="tele-section">
          <div class="tele-section-head"><span>Tokens</span></div>
          <div class="tele-card">
            <StatRow label="Total" value={formatTokens(total())} highlight />
            <StatRow label="Input" value={formatTokens(tokens().input)} />
            <StatRow label="Output" value={formatTokens(tokens().output)} />
            <Show when={tokens().reasoning > 0}><StatRow label="Reasoning" value={formatTokens(tokens().reasoning)} /></Show>
            <StatRow label="Cache read" value={formatTokens(tokens().cache.read)} sub={`${cacheHitPct()}% hit`} />
            <StatRow label="Cache write" value={formatTokens(tokens().cache.write)} />
          </div>
        </section>

        <section class="tele-section">
          <div class="tele-section-head"><span>Context</span></div>
          <div class="tele-ctx-card">
            <ContextMeter
              input={tokens().input}
              output={tokens().output}
              reasoning={tokens().reasoning}
              cacheRead={tokens().cache.read}
              cacheWrite={tokens().cache.write}
              total={props.contextTotal}
            />
          </div>
        </section>

        <section class="tele-section">
          <div class="tele-section-head"><span>Cost</span></div>
          <div class="tele-card">
            <StatRow label="Total cost" value={formatCost(props.session.cost ?? 0)} highlight />
          </div>
        </section>

        <section class="tele-section">
          <div class="tele-section-head"><span>Activity</span></div>
          <div class="tele-card">
            <StatRow label="Messages" value={String(props.messageCount)} />
            <StatRow label="Tool calls" value={String(props.toolCallCount)} />
          </div>
        </section>

        <Show when={props.session.summary}>
          <section class="tele-section">
            <div class="tele-section-head"><span>Changes</span></div>
            <div class="tele-card">
              <StatRow
                label="Files changed"
                value={String(props.session.summary!.files)}
                sub={`+${props.session.summary!.additions} −${props.session.summary!.deletions}`}
              />
            </div>
          </section>
        </Show>
      </div>
    </Sheet>
  )
}
