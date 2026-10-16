import { createMemo, createSignal, For, Show } from "solid-js"
import { Panel, RuleGrid, Stat } from "./usage-page-primitives"
import { formatNumber, formatDuration, formatPercent } from "@/components/usage/usage-format"
import { workloadSignals } from "./usage-workload-insights"

/** Browser-side contract of /usage/workload, owned by the V1 Usage service. */
export type UsageWorkloadResponse = {
  since: number
  until: number
  providerID: string | null
  modelID: string | null
  projectID: string | null
  watermark: { generationCompletedAt: number | null; toolCompletedAt: number | null }
  generation: {
    settlements: number
    quantiles: "exact" | "suppressed-large-cohort"
    requestToFirstToken: Distribution
    clientToFirstToken: Distribution
    streamedGeneration: Distribution
    providerInternalTTFT: Distribution | null
  }
  tools: {
    provenance: "producer-settlement" | "unavailable"
    coverage: "recorded-only; historical calls may be missing" | "unavailable"
    firstRecordedAt: number | null
    quantiles: "exact" | "suppressed-large-cohort" | "unavailable"
    totals: ToolCounts
    rows: ToolRow[]
    topFailingRows: ToolRow[]
    topSlowRows: ToolRow[]
    totalTools: number
    omittedTools: number
  }
  /** Producer-owned ranking by native tool calls in the exact selected cohort. */
  projects?: {
    provenance: "producer-settlement" | "unavailable"
    coverage: "recorded-only; historical calls may be missing" | "unavailable"
    quantiles?: "exact" | "suppressed-large-cohort" | "unavailable"
    totals: ToolCounts
    rows: ProjectToolRow[]
    topFailingRows?: ProjectToolRow[]
    topSlowRows?: ProjectToolRow[]
    totalProjects: number
    omittedProjects: number
  }
  generationProjects?: {
    provenance: "producer-settlement" | "unavailable"
    coverage: "recorded-only; historical calls may be missing" | "unavailable"
    totals: GenerationProjectTotals
    unattributed: GenerationProjectTotals
    rows: (GenerationProjectTotals & {
      project: string; projectName: string | null; providerID: string; modelID: string
    })[]
    totalProjects: number
    omittedProjects: number
  }
}
type GenerationProjectTotals = {
  settlements: number
  generationMs: number
  generationRecords: number
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
  tokenRecords: number
}
type Distribution = { samples: number; sumMs: number; p50Ms: number | null; p95Ms: number | null }
type ToolCounts = {
  calls: number
  success: number
  error: number
  abort: number
  denied: number
  timeout: number
  unknown: number
  duration: Distribution
}
type ToolRow = ToolCounts & { tool: string }
type ProjectToolRow = ToolCounts & { project: string; projectName?: string | null; topTools?: ToolRow[] }

type Rank = "calls" | "error" | "duration" | "failureRate"
type ProjectRank = "calls" | "error" | "duration" | "failureRate"
type GenerationRank = "settlements" | "generationMs" | "output"
const unit = "en-US"
const asDuration = (value: number | null) => value == null ? "—" : formatDuration(value, unit)
const asPercent = (value: number | null) => value == null ? "—" : formatPercent(value, unit)
const count = (value: number) => formatNumber(value, unit)
const failureRate = (row: ToolCounts) => row.error + row.success ? row.error / (row.error + row.success) : null
function score(row: ToolRow, by: Rank) {
  if (by === "duration") return row.duration.sumMs
  if (by === "failureRate") return failureRate(row) ?? -1
  return row[by]
}

/**
 * Dense, scoped diagnostic instrument. One bounded server projection (not
 * conversation hydration) powers both generation percentiles and tool outcomes.
 */
export function UsageWorkloadPanel(props: {
  value?: UsageWorkloadResponse
  loading: boolean
  error?: unknown
  /** Known project names only; never use current workspace as attribution. */
  projectNames?: Record<string, string>
  onProjectSelect?: (id: string | null) => void
  onModelSelect?: (providerID: string, modelID: string) => void
}) {
  const [sort, setSort] = createSignal<Rank>("calls")
  const [board, setBoard] = createSignal<"volume" | "failures" | "time">("volume")
  const [selectedTool, setSelectedTool] = createSignal<string | null>(null)
  const [projectRank, setProjectRank] = createSignal<ProjectRank>("calls")
  const [projectBoard, setProjectBoard] = createSignal<"volume" | "failures" | "time">("volume")
  const [selectedProject, setSelectedProject] = createSignal<string | null>(null)
  const projectScore = (row: ToolCounts, rank: ProjectRank) =>
    rank === "duration" ? row.duration.sumMs : rank === "error" ? row.error :
    rank === "failureRate" ? (failureRate(row) ?? -1) : row.calls
  const projectRows = createMemo(() => (
    projectBoard() === "failures" ? props.value?.projects?.topFailingRows ?? props.value?.projects?.rows ?? [] :
    projectBoard() === "time" ? props.value?.projects?.topSlowRows ?? props.value?.projects?.rows ?? [] :
    props.value?.projects?.rows ?? []).slice().sort((a, b) =>
    (projectScore(b, projectRank()) - projectScore(a, projectRank())) ||
    a.project.localeCompare(b.project)))
  const [generationRank, setGenerationRank] = createSignal<GenerationRank>("settlements")
  const generationScore = (row: GenerationProjectTotals, rank: GenerationRank) =>
    rank === "output" ? row.tokens.output + row.tokens.reasoning : row[rank]
  const generationProjects = createMemo(() => (props.value?.generationProjects?.rows ?? []).slice().sort((a, b) =>
    generationScore(b, generationRank()) - generationScore(a, generationRank()) ||
    a.project.localeCompare(b.project) || a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID)))
  const rows = createMemo(() => (board() === "failures"
    ? props.value?.tools.topFailingRows ?? []
    : board() === "time" ? props.value?.tools.topSlowRows ?? []
    : props.value?.tools.rows ?? []).slice().sort((a, b) =>
    score(b, sort()) - score(a, sort()) || a.tool.localeCompare(b.tool)))
  const totals = () => props.value?.tools.totals
  const timing = () => props.value?.generation
  const signals = createMemo(() => props.value ? workloadSignals(props.value) : [])
  const phases = createMemo(() => [
    { label: "Host dispatch → first token", distribution: timing()?.requestToFirstToken },
    { label: "Client setup → first token", distribution: timing()?.clientToFirstToken },
    { label: "First token → stream end", distribution: timing()?.streamedGeneration },
  ])
  const latencyScale = createMemo(() => Math.max(1, ...phases().map((phase) => phase.distribution?.p95Ms ?? 0)))
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <Panel title="Latency profiling" accessory={
        <span class="text-[10px] tabular-nums text-v2-text-text-faint">
          {props.loading ? "Reading observations…" : timing() ? count(timing()!.settlements) + " generations" : "Unavailable"}
        </span>
      } flush>
        <Show when={props.error}>
          <div class="border-b border-[var(--usage-line)] px-3 py-2 text-[11px] text-v2-state-fg-danger">
            Latency projection unavailable: {String(props.error)}
          </div>
        </Show>
        <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <For each={[
            ["Host TTFT P50", timing()?.requestToFirstToken],
            ["Host TTFT P95", timing()?.requestToFirstToken, true],
            ["Client TTFT P50", timing()?.clientToFirstToken],
            ["Client TTFT P95", timing()?.clientToFirstToken, true],
            ["Generation P50", timing()?.streamedGeneration],
            ["Generation P95", timing()?.streamedGeneration, true],
          ] as const}>{([label, sample, high]) =>
            <Stat label={label ?? ""} value={asDuration((high ? sample?.p95Ms : sample?.p50Ms) ?? null)}
              sub={sample ? count(sample.samples) + " measured" : "No measurements"} />
          }</For>
        </RuleGrid>
        <div class="grid grid-cols-1 gap-px border-t border-[var(--usage-line)] bg-[var(--usage-line)] lg:grid-cols-3">
          <For each={phases()}>{(phase) => (
            <div class="min-w-0 bg-[var(--usage-panel)] px-3 py-2">
              <div class="mb-1.5 flex items-baseline justify-between gap-2">
                <span class="truncate text-[10px] text-v2-text-text-muted" title={phase.label}>{phase.label}</span>
                <span class="shrink-0 text-[9px] tabular-nums text-v2-text-text-faint">
                  P50 {asDuration(phase.distribution?.p50Ms ?? null)} · P95 {asDuration(phase.distribution?.p95Ms ?? null)}
                </span>
              </div>
              <div class="relative h-[6px] overflow-hidden rounded-[2px] bg-v2-background-bg-layer-02"
                role="img" aria-label={`${phase.label}: P50 ${asDuration(phase.distribution?.p50Ms ?? null)}, P95 ${asDuration(phase.distribution?.p95Ms ?? null)}`}>
                <Show when={phase.distribution?.p95Ms != null}>
                  <div class="absolute inset-y-0 left-0 bg-v2-text-text-faint/35"
                    style={{width: (100 * (phase.distribution?.p95Ms ?? 0) / latencyScale()) + "%"}} />
                  <div class="absolute inset-y-0 w-[2px] bg-v2-text-text-base"
                    style={{left: (100 * (phase.distribution?.p50Ms ?? 0) / latencyScale()) + "%"}} />
                </Show>
              </div>
              <div class="mt-1 text-right text-[9px] tabular-nums text-v2-text-text-faint">
                {count(phase.distribution?.samples ?? 0)} measured · common P95 axis {asDuration(latencyScale())}
              </div>
            </div>
          )}</For>
        </div>
        <div class="border-t border-[var(--usage-line)] px-3 py-2 text-[10px] leading-4 text-v2-text-text-faint">
          Host TTFT: dispatch → first streamed content. Client TTFT: assistant creation → first content
          (including local queue/setup). Generation: first streamed content → stream end. Provider-internal TTFT
          is not emitted by these records and is explicitly unavailable; these clocks are not interchangeable.
          <Show when={timing()?.quantiles === "suppressed-large-cohort"}>
            {" "}This cohort exceeds the 10,000-settlement exact-percentile limit: exact counts and sums are retained,
            but percentile sorting is suppressed to protect interactive latency.
          </Show>
        </div>
      </Panel>

      <Panel title={props.value?.modelID ? "Model · native tool execution" :
        props.value?.providerID ? "Provider · native tool execution" : "Global · native tool execution"} accessory={
        <span class="text-[10px] tabular-nums text-v2-text-text-faint">
          {props.value?.tools.provenance === "producer-settlement"
            ? count(props.value.tools.totalTools) + " tool kinds · recorded-only"
            : "Producer telemetry unavailable"}
        </span>
      } flush>
        <Show when={props.value?.tools.provenance === "unavailable"}>
          <div class="px-3 py-3 text-[11px] text-v2-text-text-faint">
            Historical native tool invocations have no authoritative outcome/duration projection in this database.
            This is unavailable telemetry, not zero tool usage.
          </div>
        </Show>
        <Show when={props.value?.tools.provenance === "producer-settlement"}>
          <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Tool calls" value={count(totals()?.calls ?? 0)} sub="terminal settlements" />
            <Stat label="Succeeded" value={count(totals()?.success ?? 0)} />
            <Stat label="Failed" value={count(totals()?.error ?? 0)} sub="excludes abort / denied / timeout" />
            <Stat label="Failure rate" value={asPercent(totals() ? failureRate(totals()!) : null)}
              sub="error / (error + success)" />
            <Stat label="Tool wall" value={totals()?.duration.samples ? asDuration(totals()!.duration.sumMs) : "—"}
              sub="overlapping, not elapsed time" />
            <Stat label="Tool P95" value={asDuration(totals()?.duration.p95Ms ?? null)}
              sub={(totals() ? count(totals()!.duration.samples) : "0") + " timed"} />
          </RuleGrid>
          <Show when={signals().length}>
            <div class="grid grid-cols-1 gap-px border-t border-[var(--usage-line)] bg-[var(--usage-line)] md:grid-cols-2 xl:grid-cols-3"
              aria-label="Observed workload concentration diagnostics">
              <For each={signals()}>{(signal) => (
                <div class="flex min-w-0 items-center gap-2 bg-[var(--usage-panel)] px-3 py-2">
                  <div class="shrink-0 text-[15px] font-[620] tabular-nums text-v2-text-text-base">{signal.value}</div>
                  <div class="min-w-0">
                    <div class="text-[10px] font-[600] text-v2-text-text-base">{signal.title}</div>
                    <div class="text-[9px] leading-3 text-v2-text-text-faint">{signal.detail}</div>
                  </div>
                </div>
              )}</For>
            </div>
          </Show>
          <div class="flex min-h-8 items-center gap-2 border-t border-[var(--usage-line)] px-3">
            <strong class="text-[10px] font-[580]">Tool rankings</strong>
            <button type="button" aria-pressed={board() === "volume"}
              onClick={() => { setBoard("volume"); setSort("calls") }}
              class="rounded px-2 py-1 text-[10px]" classList={{
                "bg-v2-background-bg-layer-02 text-v2-text-text-base": board() === "volume",
                "text-v2-text-text-faint": board() !== "volume",
              }}>Most used</button>
            <button type="button" aria-pressed={board() === "failures"}
              onClick={() => { setBoard("failures"); setSort("error") }}
              class="rounded px-2 py-1 text-[10px]" classList={{
                "bg-v2-background-bg-layer-02 text-v2-text-text-base": board() === "failures",
                "text-v2-text-text-faint": board() !== "failures",
              }}>Most failing</button>
            <button type="button" aria-pressed={board() === "time"}
              onClick={() => { setBoard("time"); setSort("duration") }}
              class="rounded px-2 py-1 text-[10px]" classList={{
                "bg-v2-background-bg-layer-02 text-v2-text-text-base": board() === "time",
                "text-v2-text-text-faint": board() !== "time",
              }}>Most time</button>
            <span class="ml-auto text-[10px] tabular-nums text-v2-text-text-faint">{rows().length} rows</span>
          </div>
          <div class="overflow-x-auto border-t border-[var(--usage-line)]">
            <table class="w-full min-w-[690px] border-collapse text-[11px] tabular-nums">
              <thead class="bg-v2-background-bg-layer-02 text-[10px] text-v2-text-text-faint">
                <tr class="h-8 border-b border-[var(--usage-line)]">
                  <th scope="col" class="px-3 text-left font-[550]">Tool</th>
                  <For each={[
                    ["calls","Calls"], ["error","Failed"],["failureRate","Failure %"], ["duration","Tool wall"],
                  ] as const}>{([key,label]) =>
                    <th scope="col" aria-sort={sort() === key ? "descending" : "none"} class="px-2 text-right font-[550]">
                      <button type="button" class="hover:text-v2-text-text-base" onClick={() => setSort(key)}>{label}{sort() === key ? " ↓" : ""}</button>
                    </th>
                  }</For>
                  <th scope="col" class="px-3 text-right font-[550]">P50 / P95</th>
                  <th scope="col" class="px-3 text-right font-[550]">Abort / Deny / Timeout</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>{(row) =>
                  <>
                  <tr class="h-7 border-b border-[var(--usage-line)] hover:bg-v2-background-bg-layer-02"
                    data-selected={selectedTool() === row.tool ? "true" : undefined}>
                    <td class="max-w-72 truncate px-3 font-mono text-v2-text-text-base" title={row.tool}>
                      <button type="button" class="flex max-w-full items-center gap-2 truncate text-left hover:underline focus-visible:underline"
                        aria-expanded={selectedTool() === row.tool}
                        aria-label={`Inspect ${row.tool} execution statistics`}
                        onClick={() => setSelectedTool(selectedTool() === row.tool ? null : row.tool)}>
                        <span class="max-w-64 truncate">{row.tool}</span>
                        <span class="shrink-0 text-v2-text-text-faint opacity-60" aria-hidden="true">{selectedTool() === row.tool ? "⌄" : "›"}</span>
                      </button>
                    </td>
                    <td class="px-2 text-right">{count(row.calls)}</td>
                    <td class="px-2 text-right" classList={{"text-v2-state-fg-danger": row.error > 0}}>{count(row.error)}</td>
                    <td class="px-2 text-right">{asPercent(failureRate(row))}</td>
                    <td class="px-2 text-right">{row.duration.samples ? asDuration(row.duration.sumMs) : "—"}</td>
                    <td class="px-3 text-right">{asDuration(row.duration.p50Ms)} / {asDuration(row.duration.p95Ms)}</td>
                    <td class="px-3 text-right text-v2-text-text-faint">{count(row.abort)} / {count(row.denied)} / {count(row.timeout)}</td>
                  </tr>
                  <Show when={selectedTool() === row.tool}>
                    <tr class="border-b border-[var(--usage-line)] bg-v2-background-bg-layer-02/55">
                      <td colSpan={7} class="px-3 py-2">
                        <div class="mb-1.5 text-[10px] font-[610] text-v2-text-text-base">
                          {row.tool} · scoped producer-recorded outcomes
                        </div>
                        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] tabular-nums sm:grid-cols-4 xl:grid-cols-8">
                          <For each={[
                            ["Calls", count(row.calls)],
                            ["Success", count(row.success)],
                            ["Error", count(row.error)],
                            ["Timeout", count(row.timeout)],
                            ["Aborted", count(row.abort)],
                            ["Denied", count(row.denied)],
                            ["Unknown", count(row.unknown)],
                            ["Timed", row.calls ? asPercent(row.duration.samples / row.calls) : "—"],
                            ["P50", asDuration(row.duration.p50Ms)],
                            ["P95", asDuration(row.duration.p95Ms)],
                            ["Accumulated wall", row.duration.samples ? asDuration(row.duration.sumMs) : "—"],
                            ["Failure / settled", asPercent(failureRate(row))],
                          ] as const}>{([name, value]) => (
                            <div class="min-w-0">
                              <span class="text-v2-text-text-faint">{name}</span>
                              <div class="font-[590] text-v2-text-text-base">{value}</div>
                            </div>
                          )}</For>
                        </div>
                        <p class="mt-2 text-[9px] text-v2-text-text-faint">
                          Only terminal recorded invocations count. Error rate excludes abort, denial, timeout and unknown.
                          Accumulated wall intervals may overlap; this is not elapsed task time.
                        </p>
                      </td>
                    </tr>
                  </Show>
                  </>
                }</For>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-1 px-3 py-2 text-[10px] text-v2-text-text-faint">
            <span>{count(totals()?.unknown ?? 0)} unknown · {count(props.value?.tools.omittedTools ?? 0)} tool kinds beyond top-N
              <Show when={props.value?.tools.quantiles === "suppressed-large-cohort"}>
                {" "}· Large-cohort percentiles withheld; exact counts and wall sums retained
              </Show>
            </span>
            <span>Telemetry starts {props.value?.tools.firstRecordedAt == null ? "at an unknown date"
              : new Date(props.value.tools.firstRecordedAt).toLocaleString()}; older sessions may be incomplete.</span>
          </div>
        </Show>
      </Panel>
      <Panel title={props.value?.modelID ? "Top projects · model generations" : "Top project × model cohorts"}
        accessory={
          <span class="text-[10px] tabular-nums text-v2-text-text-faint">
            {props.value?.generationProjects
              ? count(props.value.generationProjects.totalProjects) + " distinct projects"
              : "Generation project telemetry unavailable"}
          </span>
        } flush>
        <Show when={props.value?.generationProjects?.provenance === "producer-settlement"} fallback={
          <div class="px-3 py-3 text-[11px] text-v2-text-text-faint">
            {props.loading ? "Reading model/project generations…" : "Generation/project attribution is not available on this server."}
          </div>
        }>
          <div class="flex min-h-8 flex-wrap items-center gap-2 border-b border-[var(--usage-line)] px-3 py-1">
            <span class="text-[10px] text-v2-text-text-muted">
              Settled model calls · grouped by project, provider and model · even when no tools ran
            </span>
            <Show when={props.onProjectSelect && props.value?.projectID}>
              <button type="button" onClick={() => props.onProjectSelect?.(null)}
                class="ml-auto rounded-[5px] border border-[var(--usage-line)] px-2 py-1 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02">
                Clear project
              </button>
            </Show>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[740px] border-collapse text-[11px] tabular-nums">
              <thead class="bg-v2-background-bg-layer-02 text-[10px] text-v2-text-text-faint">
                <tr class="h-7 border-b border-[var(--usage-line)]">
                  <th scope="col" class="px-3 text-left font-[550]">Project</th>
                  <th scope="col" class="px-2 text-left font-[550]">Provider / Model</th>
                  <For each={[
                    ["settlements", "Calls"], ["generationMs", "Generating"], ["output", "Output"],
                  ] as const}>{([key, label]) =>
                    <th scope="col" aria-sort={generationRank() === key ? "descending" : "none"}
                      class="px-2 text-right font-[550]">
                      <button type="button" class="hover:text-v2-text-text-base"
                        onClick={() => setGenerationRank(key)}>{label}{generationRank() === key ? " ↓" : ""}</button>
                    </th>
                  }</For>
                  <th scope="col" class="px-2 text-right font-[550]">Cache read</th>
                  <th scope="col" class="px-3 text-right font-[550]">Timed / all</th>
                </tr>
              </thead>
              <tbody>
                <For each={generationProjects()}>{(row) =>
                  <tr class="h-7 border-b border-[var(--usage-line)] hover:bg-v2-background-bg-layer-02">
                    <td class="max-w-72 truncate px-3 text-v2-text-text-base">
                      <Show when={props.onProjectSelect && row.project !== "__historical__" && row.project !== "unattributed" && row.project !== "unknown"}
                        fallback={<span class="truncate" title={row.project}>{props.projectNames?.[row.project] ?? row.projectName ?? row.project}</span>}>
                        <button type="button" class="group flex max-w-full items-center gap-1.5 truncate text-left focus-visible:underline"
                          title={row.project} onClick={() => props.onProjectSelect?.(row.project)}>
                          <span class="truncate group-hover:underline">{props.projectNames?.[row.project] ?? row.projectName ?? row.project}</span>
                          <span class="text-v2-text-text-faint opacity-40 group-hover:opacity-100" aria-hidden="true">›</span>
                        </button>
                      </Show>
                    </td>
                    <td class="max-w-60 truncate px-2 font-mono text-[10px] text-v2-text-text-muted">
                      <Show when={props.onModelSelect} fallback={
                        <span class="truncate" title={row.providerID + "/" + row.modelID}>{row.providerID} / {row.modelID}</span>
                      }>
                        <button type="button" class="max-w-full truncate text-left hover:underline focus-visible:underline"
                          title={row.providerID + "/" + row.modelID}
                          onClick={() => props.onModelSelect?.(row.providerID, row.modelID)}>
                          {row.providerID} / {row.modelID}
                        </button>
                      </Show>
                    </td>
                    <td class="px-2 text-right">{count(row.settlements)}</td>
                    <td class="px-2 text-right">{row.generationRecords ? asDuration(row.generationMs) : "—"}</td>
                    <td class="px-2 text-right">{row.tokenRecords ? count(row.tokens.output + row.tokens.reasoning) : "—"}</td>
                    <td class="px-2 text-right">{row.tokenRecords ? count(row.tokens.cacheRead) : "—"}</td>
                    <td class="px-3 text-right text-v2-text-text-faint">{count(row.generationRecords)} / {count(row.settlements)}</td>
                  </tr>
                }</For>
              </tbody>
            </table>
          </div>
          <Show when={generationProjects().length === 0}>
            <div class="px-3 py-5 text-center text-[11px] text-v2-text-text-faint">No model generations in this exact cohort.</div>
          </Show>
          <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[10px] text-v2-text-text-faint">
            <span>{count(props.value?.generationProjects?.omittedProjects ?? 0)} distinct projects not represented among top rows · {count(props.value?.generationProjects?.unattributed.settlements ?? 0)} unattributed model calls</span>
            <span>Top-N selected by calls; other sorts reorder visible cohorts. Token samples: {count(props.value?.generationProjects?.totals.tokenRecords ?? 0)}</span>
          </div>
        </Show>
      </Panel>
      <Panel title="Projects · native tool activity" accessory={
        <span class="text-[10px] tabular-nums text-v2-text-text-faint">
          {props.value?.projects ? count(props.value.projects.totalProjects) + " attributed projects" : "Project telemetry unavailable"}
        </span>
      } flush>
        <Show when={props.value?.projects?.provenance === "producer-settlement"} fallback={
          <div class="px-3 py-3 text-[11px] text-v2-text-text-faint">
            {props.loading ? "Reading project attribution…" :
              "Project-level native tool telemetry is not available from this server. Historical calls must not be counted as zero."}
          </div>
        }>
          <div class="flex min-h-8 flex-wrap items-center gap-2 border-b border-[var(--usage-line)] px-3 py-1">
            <span class="mr-1 text-[10px] text-v2-text-text-muted">Rank</span>
            <For each={[
              ["volume", "Most used", "calls"],
              ["failures", "Most failing", "error"],
              ["time", "Most time", "duration"],
            ] as const}>{([key, label, rank]) => (
              <button type="button" aria-pressed={projectBoard() === key}
                disabled={key === "failures" && !props.value?.projects?.topFailingRows ||
                  key === "time" && !props.value?.projects?.topSlowRows}
                onClick={() => { setProjectBoard(key); setProjectRank(rank); setSelectedProject(null) }}
                class="rounded-[4px] px-2 py-1 text-[10px] disabled:opacity-35"
                classList={{
                  "bg-v2-background-bg-layer-02 text-v2-text-text-base": projectBoard() === key,
                  "text-v2-text-text-faint hover:text-v2-text-text-base": projectBoard() !== key,
                }}>{label}</button>
            )}</For>
            <Show when={props.onProjectSelect && props.value?.projectID}>
              <button type="button" onClick={() => props.onProjectSelect?.(null)}
                class="ml-auto rounded-[5px] border border-[var(--usage-line)] px-2 py-1 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02">
                Clear project
              </button>
            </Show>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[610px] border-collapse text-[11px] tabular-nums">
              <thead class="bg-v2-background-bg-layer-02 text-[10px] text-v2-text-text-faint">
                <tr class="h-7 border-b border-[var(--usage-line)]">
                  <th scope="col" class="px-3 text-left font-[550]">Project</th>
                  <For each={[
                    ["calls", "Tool calls"], ["error", "Errors"], ["duration", "Tool wall"],
                  ] as const}>{([key, label]) =>
                    <th scope="col" aria-sort={projectRank() === key ? "descending" : "none"} class="px-2 text-right font-[550]">
                      <button type="button" class="hover:text-v2-text-text-base"
                        onClick={() => setProjectRank(key)}>{label}{projectRank() === key ? " ↓" : ""}</button>
                    </th>
                  }</For>
                  <th scope="col" aria-sort={projectRank() === "failureRate" ? "descending" : "none"} class="px-2 text-right font-[550]">
                    <button type="button" class="hover:text-v2-text-text-base"
                      onClick={() => setProjectRank("failureRate")}>Failure %{projectRank() === "failureRate" ? " ↓" : ""}</button>
                  </th>
                  <th scope="col" class="px-3 text-right font-[550]">Timed / all</th>
                </tr>
              </thead>
              <tbody>
                <For each={projectRows()}>{(row) =>
                  <>
                  <tr class="h-7 border-b border-[var(--usage-line)] hover:bg-v2-background-bg-layer-02">
                    <td class="max-w-80 truncate px-3 text-v2-text-text-base">
                      <div class="flex max-w-full items-center gap-2">
                        <Show when={props.onProjectSelect && row.project !== "unknown"} fallback={
                          <span class="truncate" title={row.project}>{props.projectNames?.[row.project] ?? row.projectName ?? row.project}</span>
                        }>
                          <button type="button" class="group flex max-w-full items-center gap-1.5 truncate text-left focus-visible:underline"
                            title={row.project} onClick={() => props.onProjectSelect?.(row.project)}>
                            <span class="truncate group-hover:underline">{props.projectNames?.[row.project] ?? row.projectName ?? row.project}</span>
                            <span class="text-v2-text-text-faint opacity-40 group-hover:opacity-100" aria-hidden="true">›</span>
                          </button>
                        </Show>
                        <Show when={row.topTools?.length}>
                          <button type="button" class="ml-auto shrink-0 rounded-[4px] px-1.5 py-0.5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                            aria-label={`Inspect top native tools for ${props.projectNames?.[row.project] ?? row.projectName ?? row.project}`}
                            aria-expanded={selectedProject() === row.project}
                            onClick={() => setSelectedProject(selectedProject() === row.project ? null : row.project)}>
                            {selectedProject() === row.project ? "⌄" : "›"}
                          </button>
                        </Show>
                      </div>
                    </td>
                    <td class="px-2 text-right">{count(row.calls)}</td>
                    <td class="px-2 text-right" classList={{"text-v2-state-fg-danger": row.error > 0}}>{count(row.error)}</td>
                    <td class="px-2 text-right">{row.duration.samples ? asDuration(row.duration.sumMs) : "—"}</td>
                    <td class="px-2 text-right">{asPercent(failureRate(row))}</td>
                    <td class="px-3 text-right text-v2-text-text-faint">{count(row.duration.samples)} / {count(row.calls)}</td>
                  </tr>
                  <Show when={selectedProject() === row.project && row.topTools?.length}>
                    <tr class="border-b border-[var(--usage-line)] bg-v2-background-bg-layer-02/55">
                      <td colSpan={6} class="px-3 py-2">
                        <div class="mb-2 flex items-baseline gap-3 text-[10px]">
                          <strong class="font-[610] text-v2-text-text-base">Dominant tools · {props.projectNames?.[row.project] ?? row.projectName ?? row.project}</strong>
                          <span class="tabular-nums text-v2-text-text-faint">Project tool P50 {asDuration(row.duration.p50Ms)} · P95 {asDuration(row.duration.p95Ms)}</span>
                        </div>
                        <div class="grid grid-cols-1 gap-px bg-[var(--usage-line)] md:grid-cols-2">
                          <For each={row.topTools ?? []}>{(tool) =>
                            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 bg-[var(--usage-panel)] px-2 py-1 text-[10px] tabular-nums">
                              <span class="truncate font-mono text-v2-text-text-base" title={tool.tool}>{tool.tool}</span>
                              <span class="text-v2-text-text-muted">{count(tool.calls)} calls</span>
                              <span classList={{"text-v2-state-fg-danger": tool.error > 0}}>{count(tool.error)} errors</span>
                              <span class="text-v2-text-text-faint">{tool.duration.samples ? asDuration(tool.duration.sumMs) : "—"}</span>
                            </div>
                          }</For>
                        </div>
                        <p class="mt-1.5 text-[9px] text-v2-text-text-faint">Tool ranking is based on producer-recorded invocations; counts may be incomplete for historical sessions.</p>
                      </td>
                    </tr>
                  </Show>
                  </>
                }</For>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap justify-between gap-2 px-3 py-2 text-[10px] text-v2-text-text-faint">
            <span>{count(props.value?.projects?.omittedProjects ?? 0)} projects outside volume top-N · exact provider/model/date/project scope</span>
            <span>Volume, failure and time boards are separately ranked by the producer; column sorts reorder visible rows. Tool wall may overlap.</span>
          </div>
        </Show>
      </Panel>
    </div>
  )
}
