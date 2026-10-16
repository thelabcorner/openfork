import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import {
  failureRateOf,
  rankTools,
  workloadIcon,
  workloadLabel,
  type WorkloadBoard,
  type WorkloadRank,
} from "./oxp-workload-model"

/** Browser-safe representation of the Core-owned, opt-in OXP workload projection. */
export type OxpWorkloadMetrics = {
  calls: number
  successes: number
  failures: number
  denied: number
  cancelled: number
  interrupted: number
  running: number
  unknown: number
  failureRate: number | null
  measuredDurations: number
  missingDurations: number
  toolWallMs: number
  p50Ms: number | null
  p95Ms: number | null
}

export type OxpWorkloadProfile = {
  scope: { since: number; until: number; activityID?: string }
  bucketWidthMs: number
  totals: OxpWorkloadMetrics
  tools: readonly (OxpWorkloadMetrics & { tool: string })[]
  topFailures: readonly (OxpWorkloadMetrics & { tool: string })[]
  topTime: readonly (OxpWorkloadMetrics & { tool: string })[]
  otherTools: number
  otherCalls: number
  buckets: readonly { start: number; calls: number; successes: number; failures: number }[]
  coverage: {
    historicalCompleteness: "unknown"
    quantileSampleLimit: number
    p50MinimumSamples: 5
    p95MinimumSamples: 20
  }
}

const fmt = (n: number) => n.toLocaleString("en-US")
const percent = (value: number | null) => value === null ? "—" : (value * 100).toFixed(value < 0.01 ? 1 : 0) + "%"
const duration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return Math.round(ms) + " ms"
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) + " s"
  if (ms < 3_600_000) return (ms / 60_000).toFixed(1) + " min"
  return (ms / 3_600_000).toFixed(1) + " h"
}

const BOARD_SOURCE = {
  volume: "tools",
  failures: "topFailures",
  time: "topTime",
} as const

const BOARD_LABEL: Record<WorkloadBoard, string> = {
  volume: "Most used",
  failures: "Most failing",
  time: "Most time",
}

const SORT_COLUMNS: ReadonlyArray<readonly [WorkloadRank, string]> = [
  ["calls", "Calls"],
  ["failures", "Failed"],
  ["failureRate", "Failure %"],
  ["toolWallMs", "Tool time"],
  ["p95Ms", "P50 / P95"],
]

/**
 * OXP workload inspector — the same compact tool-focused visual language as
 * OXP Session Tool Timeline, but derived from indexed scalar table summaries.
 * Rows are 28px and expandable: clicking (or Enter/Space) reveals the tool's
 * already-materialized outcome timings. It NEVER fetches individual
 * invocations, arguments, or provider configuration, and it never invents an
 * upstream model for an OXP call.
 */
export function OxpWorkloadPanel(props: { profile: OxpWorkloadProfile }) {
  const [sort, setSort] = createSignal<WorkloadRank>("calls")
  const [board, setBoard] = createSignal<WorkloadBoard>("volume")
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [bucket, setBucket] = createSignal<number | null>(null)

  const total = () => props.profile.totals
  const rows = createMemo(() => rankTools(props.profile[BOARD_SOURCE[board()]], sort()))
  const maximum = createMemo(() => Math.max(1, ...props.profile.buckets.map((entry) => entry.calls)))
  const range = () =>
    new Date(props.profile.scope.since).toLocaleDateString() + " – " +
    new Date(props.profile.scope.until).toLocaleDateString()
  const selectedBucket = createMemo(() => {
    const index = bucket()
    return index === null ? undefined : props.profile.buckets[index]
  })
  const toggle = (tool: string) => setExpanded((current) => (current === tool ? null : tool))

  return (
    <section data-slot="oxp-workload" aria-label="OXP tool execution analytics">
      <header data-slot="oxp-workload-header">
        <div class="min-w-0">
          <strong>Tool execution</strong>
          <span>Observed OXP invocations · {range()}</span>
        </div>
        <span>Indexed workload · no transcript hydration</span>
      </header>

      <div data-slot="oxp-workload-stats">
        <For each={[
          { label: "Tool calls", value: fmt(total().calls), hint: "all outcomes" },
          { label: "Succeeded", value: fmt(total().successes), hint: "confirmed successes" },
          { label: "Failed", value: fmt(total().failures), hint: "confirmed errors" },
          { label: "Failure rate", value: percent(failureRateOf(total())), hint: "failed / (failed + succeeded)" },
          { label: "Tool wall time", value: total().measuredDurations ? duration(total().toolWallMs) : "—", hint: "overlapping calls may double-count" },
          { label: "P50", value: duration(total().p50Ms), hint: fmt(total().measuredDurations) + " timing samples" },
          { label: "P95", value: duration(total().p95Ms), hint: fmt(total().missingDurations) + " missing durations" },
        ]}>
          {(item) => (
            <div data-slot="oxp-workload-stat">
              <span data-slot="oxp-workload-stat-label">{item.label}</span>
              <span data-slot="oxp-workload-stat-value">{item.value}</span>
              <span data-slot="oxp-workload-stat-hint" title={item.hint}>{item.hint}</span>
            </div>
          )}
        </For>
      </div>

      <div data-slot="oxp-workload-timeline">
        <div data-slot="oxp-workload-timeline-head">
          <strong>Call volume / failures</strong>
          <span>{props.profile.buckets.length} time buckets</span>
        </div>
        <div data-slot="oxp-workload-track" role="group" aria-label="OXP calls by time: solid neutral bars show calls; muted red overlays represent failed calls">
          <For each={props.profile.buckets}>
            {(entry, index) => {
              const height = () => Math.max(0, entry.calls) / maximum() * 100
              const failHeight = () => entry.calls ? Math.max(0, entry.failures) / entry.calls * 100 : 0
              return (
                <button
                  type="button"
                  data-slot="oxp-workload-bucket"
                  aria-pressed={bucket() === index() ? "true" : undefined}
                  aria-label={`${new Date(entry.start).toLocaleString()}: ${entry.calls} calls, ${entry.failures} failed`}
                  onClick={() => setBucket(bucket() === index() ? null : index())}
                >
                  <span data-slot="oxp-workload-bar" style={{ height: height() + "%" }}>
                    <span data-slot="oxp-workload-bar-fail" style={{ height: failHeight() + "%" }} />
                  </span>
                </button>
              )
            }}
          </For>
        </div>
        <Show when={selectedBucket()}>
          {(entry) => (
            <div data-slot="oxp-workload-readout">
              {new Date(entry().start).toLocaleString()} – {new Date(entry().start + props.profile.bucketWidthMs).toLocaleString()}
              {" · "}{fmt(entry().calls)} calls{" · "}{fmt(entry().successes)} succeeded{" · "}{fmt(entry().failures)} failed
            </div>
          )}
        </Show>
        <div data-slot="oxp-workload-axis">
          <span>{new Date(props.profile.scope.since).toLocaleString()}</span>
          <span>{new Date(props.profile.scope.until).toLocaleString()}</span>
        </div>
      </div>

      <div data-slot="oxp-workload-board">
        <div data-slot="oxp-workload-board-head">
          <div class="flex items-center gap-1.5">
            <strong>Tool leaderboard</strong>
            <For each={(["volume", "failures", "time"] as const)}>
              {(option) => (
                <button
                  type="button"
                  data-slot="oxp-workload-board-toggle"
                  aria-pressed={board() === option}
                  onClick={() => { setBoard(option); setSort(option === "failures" ? "failures" : option === "time" ? "toolWallMs" : "calls") }}
                >
                  {BOARD_LABEL[option]}
                </button>
              )}
            </For>
          </div>
          <span>{fmt(rows().length)} shown</span>
        </div>
        <div data-slot="oxp-workload-table-wrap">
          <table data-slot="oxp-workload-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <For each={SORT_COLUMNS}>
                  {([key, label]) => (
                    <th scope="col" aria-sort={sort() === key ? "descending" : "none"}>
                      <button type="button" onClick={() => setSort(key)}>{label}{sort() === key ? " ↓" : ""}</button>
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <>
                    <tr data-slot="oxp-workload-row" data-expanded={expanded() === row.tool ? "true" : undefined}>
                      <td data-cell="tool">
                        <button
                          type="button"
                          data-slot="oxp-workload-row-toggle"
                          aria-expanded={expanded() === row.tool}
                          aria-label={`Inspect ${workloadLabel(row.tool)} outcome timings`}
                          onClick={() => toggle(row.tool)}
                        >
                          <Icon name={workloadIcon(row.tool)} size="small" />
                          <span class="truncate">{workloadLabel(row.tool)}</span>
                          <span data-slot="oxp-workload-row-chevron" aria-hidden="true">{expanded() === row.tool ? "⌄" : "›"}</span>
                        </button>
                      </td>
                      <td>{fmt(row.calls)}</td>
                      <td data-cell="danger" classList={{ "is-danger": row.failures > 0 }}>{fmt(row.failures)}</td>
                      <td>{percent(failureRateOf(row))}</td>
                      <td>{row.measuredDurations ? duration(row.toolWallMs) : "—"}</td>
                      <td>{duration(row.p50Ms)} / {duration(row.p95Ms)}</td>
                    </tr>
                    <Show when={expanded() === row.tool}>
                      <tr data-slot="oxp-workload-inspector">
                        <td colSpan={6}>
                          <div data-slot="oxp-workload-inspector-title">
                            {workloadLabel(row.tool)} · scoped producer-recorded outcomes
                          </div>
                          <div data-slot="oxp-workload-inspector-group">
                            <span data-slot="oxp-workload-inspector-group-label">Outcomes</span>
                            <div data-slot="oxp-workload-inspector-grid">
                              <For each={[
                                ["Success", fmt(row.successes)],
                                ["Failed", fmt(row.failures)],
                                ["Denied", fmt(row.denied)],
                                ["Cancelled", fmt(row.cancelled)],
                                ["Interrupted", fmt(row.interrupted)],
                                ["Running", fmt(row.running)],
                                ["Unknown", fmt(row.unknown)],
                              ] as const}>
                                {([label, value]) => (
                                  <div data-slot="oxp-workload-inspector-cell">
                                    <span>{label}</span>
                                    <strong classList={{ "is-danger": label === "Failed" && row.failures > 0 }}>{value}</strong>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                          <div data-slot="oxp-workload-inspector-group">
                            <span data-slot="oxp-workload-inspector-group-label">Timing</span>
                            <div data-slot="oxp-workload-inspector-grid">
                              <For each={[
                                ["P50", duration(row.p50Ms)],
                                ["P95", duration(row.p95Ms)],
                                ["Accumulated wall", row.measuredDurations ? duration(row.toolWallMs) : "—"],
                                ["Measured", fmt(row.measuredDurations)],
                                ["Missing", fmt(row.missingDurations)],
                                ["Failure rate", percent(failureRateOf(row))],
                              ] as const}>
                                {([label, value]) => (
                                  <div data-slot="oxp-workload-inspector-cell">
                                    <span>{label}</span>
                                    <strong>{value}</strong>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                          <p data-slot="oxp-workload-inspector-note">
                            Only terminal recorded invocations count. Failure rate excludes denial,
                            cancellation, interruption, running and unknown. Accumulated wall intervals
                            may overlap; this is not elapsed task time. P50 needs {props.profile.coverage.p50MinimumSamples} samples,
                            P95 needs {props.profile.coverage.p95MinimumSamples}; quantiles are withheld above{" "}
                            {fmt(props.profile.coverage.quantileSampleLimit)} samples.
                          </p>
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
              <Show when={props.profile.otherCalls > 0}>
                <tr data-slot="oxp-workload-row" data-muted="true">
                  <td data-cell="tool" colSpan={1}>
                    <span data-slot="oxp-workload-other">Other tools</span>
                  </td>
                  <td>{fmt(props.profile.otherCalls)}</td>
                  <td colSpan={4} />
                </tr>
              </Show>
            </tbody>
          </table>
        </div>
        <div data-slot="oxp-workload-note">
          Outcomes: {fmt(total().denied)} denied · {fmt(total().cancelled)} cancelled · {fmt(total().interrupted)} interrupted ·{" "}
          {fmt(total().running)} running · {fmt(total().unknown)} other.
          Historical completeness is unknown; missing durations are excluded from percentiles. Tool wall time
          is the sum of individual tool intervals, not elapsed session time. OXP calls are observed at the
          tool boundary with no known upstream model — this is not provider-reported ChatGPT usage.
        </div>
      </div>
    </section>
  )
}
