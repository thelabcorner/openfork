import type { UsageWorkloadResponse } from "./usage-workload-panel"

/** Evidence-only, deterministic concentration diagnostics: never causal advice. */
export type WorkloadSignal = {
  kind: "failure-concentration" | "time-concentration" | "ttft-tail"
  title: string
  value: string
  detail: string
}
const pct = (fraction: number) => (fraction * 100).toFixed(1) + "%"
const duration = (ms: number) => ms < 1_000 ? Math.round(ms) + " ms" :
  ms < 60_000 ? (ms / 1000).toFixed(1) + " s" : (ms / 60_000).toFixed(1) + " min"

export function workloadSignals(data: UsageWorkloadResponse): WorkloadSignal[] {
  const result: WorkloadSignal[] = []
  const total = data.tools.totals
  const bad = data.tools.topFailingRows[0]
  if (bad && total.error >= 3 && bad.error >= 2) {
    const fraction = bad.error / total.error
    result.push({
      kind: "failure-concentration",
      title: "Error concentration",
      value: pct(fraction),
      detail: `${bad.tool}: ${bad.error.toLocaleString()} of ${total.error.toLocaleString()} observed tool errors in this scope`,
    })
  }
  const slow = data.tools.topSlowRows[0]
  if (slow && total.duration.sumMs > 0 && slow.duration.sumMs > 0 && total.calls >= 5) {
    const fraction = slow.duration.sumMs / total.duration.sumMs
    if (fraction >= 0.25) result.push({
      kind: "time-concentration",
      title: "Tool-time concentration",
      value: pct(fraction),
      detail: `${slow.tool}: ${duration(slow.duration.sumMs)} of ${duration(total.duration.sumMs)} accumulated tool wall time; concurrency may overlap`,
    })
  }
  const ttft = data.generation.requestToFirstToken
  if (ttft.samples >= 20 && ttft.p50Ms != null && ttft.p95Ms != null && ttft.p50Ms > 0 &&
      ttft.p95Ms / ttft.p50Ms >= 3) {
    result.push({
      kind: "ttft-tail",
      title: "First-token latency tail",
      value: (ttft.p95Ms / ttft.p50Ms).toFixed(1) + "×",
      detail: `P95 ${duration(ttft.p95Ms)} vs P50 ${duration(ttft.p50Ms)} across ${ttft.samples.toLocaleString()} measured generations`,
    })
  }
  return result
}
