import { formatTokens } from "../format"

export function ContextMeter(props: {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}) {
  const used = () => props.input + props.output + props.reasoning + props.cacheRead
  const pct = () => (props.total > 0 ? Math.min(100, Math.round((used() / props.total) * 100)) : 0)
  const seg = (n: number) => (props.total > 0 ? Math.min(100, Math.round((n / props.total) * 100)) : 0)
  const colorClass = () => {
    const p = pct()
    if (p >= 85) return "ctx-critical"
    if (p >= 65) return "ctx-warn"
    if (p >= 40) return "ctx-mid"
    return "ctx-low"
  }

  return (
    <div>
      <div class="tele-ctx-head">
        <span class="label">Context window</span>
        <span class={`value ${colorClass()} tnum`}>
          {formatTokens(used())} / {formatTokens(props.total)} ({pct()}%)
        </span>
      </div>
      <div class="tele-ctx-bar">
        <div class="tele-ctx-seg user" style={{ width: `${seg(props.input)}%` }} />
        <div class="tele-ctx-seg assistant" style={{ width: `${seg(props.output + props.reasoning)}%` }} />
        <div class="tele-ctx-seg cache" style={{ width: `${seg(props.cacheRead)}%` }} />
      </div>
      <div class="tele-legend-grid">
        <div class="tele-legend-item">
          <span class="sw"><span class="dot" style={{ background: "rgba(91,141,255,0.7)" }} /><span class="name">Input</span></span>
          <span class="val tnum">{formatTokens(props.input)}</span>
        </div>
        <div class="tele-legend-item">
          <span class="sw"><span class="dot" style={{ background: "rgba(167,139,250,0.7)" }} /><span class="name">Output + reasoning</span></span>
          <span class="val tnum">{formatTokens(props.output + props.reasoning)}</span>
        </div>
        <div class="tele-legend-item">
          <span class="sw"><span class="dot" style={{ background: "rgba(255,255,255,0.2)" }} /><span class="name">Cache read</span></span>
          <span class="val tnum">{formatTokens(props.cacheRead)}</span>
        </div>
        <div class="tele-legend-item">
          <span class="sw"><span class="dot" style={{ background: "var(--surface-border)" }} /><span class="name">Cache write</span></span>
          <span class="val tnum">{formatTokens(props.cacheWrite)}</span>
        </div>
      </div>
    </div>
  )
}
