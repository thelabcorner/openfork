import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { formatDuration, formatNumber, formatPercent, formatTokensPerSecond } from "@/components/usage/usage-format"
import { Panel, RuleGrid, Stat } from "./usage-page-primitives"
import { useServerSDK } from "@/context/server-sdk"
import { UsageWorkloadPanel, type UsageWorkloadResponse } from "./usage-workload-panel"
import {
  averageMeasured, outputThroughput, performanceModels, performanceProviders,
  performanceScope, type PerformanceRow,
} from "./usage-performance-model"
import {
  globalUsageDrilldown, reconcileUsageDrilldown, usageModelScope, usageProviderScope,
  matchesUsageWorkload, usageScopeCrumbs, usageScopeTitle, usageWorkloadParams, type UsageDrilldown,
} from "./usage-drilldown-model"

type Rank = "generation" | "calls" | "latency" | "throughput" | "cache"
const MAX_ROWS = 160
const unit = "en-US"

function cacheRate(row: PerformanceRow) {
  const denominator = row.input + row.cacheRead
  return denominator > 0 ? row.cacheRead / denominator : 0
}

function rankValue(row: PerformanceRow, by: Rank) {
  switch (by) {
    case "generation": return row.generationMs
    case "calls": return row.generations
    case "latency": return averageMeasured(row.generationMs, row.measuredGenerations) ?? -1
    case "throughput": return outputThroughput(row) ?? -1
    case "cache": return cacheRate(row)
  }
}

function Value(props: { value: number | undefined; kind?: "time" | "rate" | "percent" | "number" }) {
  const value = () => props.value
  return <span class="tabular-nums">{value() === undefined ? "—" :
    props.kind === "time" ? formatDuration(value()!, unit) :
    props.kind === "rate" ? formatTokensPerSecond(value()!, unit) :
    props.kind === "percent" ? formatPercent(value()!, unit) :
    formatNumber(value()!, unit)}</span>
}

/**
 * A hierarchical, read-only workload profiler. Navigation only alters the
 * filter on an already-authoritative Tier-0 Usage query. No transcript, tool
 * history, provider catalog, workspace bootstrap, or per-row requests.
 */
export function UsagePagePerformance(props: {
  data: UsageSummaryResponse
  projectID: string | null
  refreshTick: number
  projectNames?: Record<string, string>
  onProjectSelect?: (id: string | null) => void
}) {
  const serverSDK = useServerSDK()
  const [scope, setScope] = createSignal<UsageDrilldown>(globalUsageDrilldown)
  const [order, setOrder] = createSignal<Rank>("generation")
  const [search, setSearch] = createSignal("")
  const providers = createMemo(() => performanceProviders(props.data))
  const models = createMemo(() => performanceModels(props.data))
  const providerIDs = createMemo(() => providers().map((row) => row.providerID))
  createEffect(() => {
    const next = reconcileUsageDrilldown(scope(), providerIDs(), models())
    if (next.level !== scope().level || next.providerID !== scope().providerID || next.modelID !== scope().modelID)
      setScope(next)
  })
  const children = createMemo(() =>
    scope().level === "global" ? providers() :
    models().filter((row) => row.providerID === scope().providerID))
  const visible = createMemo(() => {
    const needle = search().trim().toLocaleLowerCase()
    return children().filter((row) =>
      !needle || (row.modelID ?? row.providerID).toLocaleLowerCase().includes(needle))
      .sort((a, b) => rankValue(b, order()) - rankValue(a, order()) ||
        a.providerID.localeCompare(b.providerID) || (a.modelID ?? "").localeCompare(b.modelID ?? ""))
  })
  // All summary-derived metrics use the selected scope; project filters are
  // already applied by the Usage summary service.
  const selected = createMemo(() => {
    const s = scope()
    if (s.level === "global") return providers()
    if (s.level === "provider") return providers().filter((row) => row.providerID === s.providerID)
    return models().filter((row) => row.providerID === s.providerID && row.modelID === s.modelID)
  })
  const totals = createMemo(() => performanceScope(selected()))
  let pending: AbortController | undefined
  const [workload] = createResource(
    () => ({
      scope: serverSDK().scope,
      since: props.data.since,
      until: props.data.until,
      providerID: scope().providerID,
      modelID: scope().modelID,
      projectID: props.projectID,
      refreshTick: props.refreshTick,
    }),
    async (input) => {
      pending?.abort()
      const current = new AbortController()
      pending = current
      try {
        const response = await serverSDK().client.analyticsProjection(
          "/usage/workload",
          usageWorkloadParams(
            input.modelID && input.providerID ? usageModelScope(input.providerID, input.modelID) :
              usageProviderScope(input.providerID ?? ""),
            input.since, input.until, input.projectID, 40,
          ),
          { signal: current.signal },
        )
        return response.data as UsageWorkloadResponse
      } catch (error) {
        if (current.signal.aborted) return undefined
        throw error
      } finally {
        if (pending === current) pending = undefined
      }
    },
  )
  onCleanup(() => pending?.abort())
  const currentWorkload = () => {
    const result = workload.error ? undefined : workload()
    return matchesUsageWorkload(scope(), props.data, props.projectID, result) ? result : undefined
  }

  const selectedModel = createMemo(() => scope().level === "model" ? selected()[0] : undefined)
  const avgGeneration = () => averageMeasured(totals().generationMs, totals().measuredGenerations)
  const avgWall = () => averageMeasured(totals().wallMs, totals().wallRecords)
  const tps = () => totals().generationMs > 0
    ? (totals().output + totals().reasoning) * 1000 / totals().generationMs : undefined
  const readShare = () => {
    const t = totals()
    return t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : undefined
  }
  const ttft = () => scope().level === "global" && props.data.totals.ttftRecords > 0
    ? props.data.totals.ttftMs / props.data.totals.ttftRecords : undefined
  const navigate = (next: UsageDrilldown) => {
    setScope(next)
    setSearch("")
  }

  return (
    <div data-component="usage-performance" data-scope={scope().level} class="flex min-w-0 flex-col gap-3">
      <Panel flush>
        <nav aria-label="Usage analysis scope" class="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-[var(--usage-line)] px-3 py-1.5">
          <span class="mr-1 text-[9px] font-[620] uppercase tracking-[0.055em] text-v2-text-text-faint">Profiler</span>
          <For each={usageScopeCrumbs(scope())}>{(crumb, index) => (
            <>
              <Show when={index() > 0}><span class="text-v2-text-text-faint/50" aria-hidden="true">/</span></Show>
              <button type="button" aria-current={crumb.target.level === scope().level ? "page" : undefined}
                onClick={() => navigate(crumb.target)}
                class="max-w-64 truncate rounded-[5px] px-1.5 py-1 text-[11px] hover:bg-v2-background-bg-layer-02 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-v2-text-text-accent"
                classList={{
                  "font-[620] text-v2-text-text-base": crumb.target.level === scope().level,
                  "text-v2-text-text-muted": crumb.target.level !== scope().level,
                }}>{crumb.label}</button>
            </>
          )}</For>
          <span class="ml-auto text-[10px] tabular-nums text-v2-text-text-faint">
            {formatNumber(totals().generations, unit)} settled · {formatNumber(totals().measuredGenerations, unit)} timed
          </span>
        </nav>
        <div class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--usage-line)] px-3 py-2">
          <div class="flex min-w-0 flex-col">
            <strong class="truncate text-[12px] font-[630] text-v2-text-text-base" title={usageScopeTitle(scope())}>
              {scope().level === "global" ? "Global workload" : usageScopeTitle(scope())}
            </strong>
            <span class="text-[10px] text-v2-text-text-faint">
              {scope().level === "global" ? "All recorded providers and models" :
               scope().level === "provider" ? "Provider profile · select a model to inspect its workload" :
               "Model profile · observed calls, tools, latency and attributed projects"}
            </span>
          </div>
          <div class="ml-auto flex items-center gap-2 text-[10px] text-v2-text-text-faint">
            <Show when={props.projectID}>
              <span class="max-w-48 truncate rounded-[4px] bg-v2-background-bg-layer-02 px-2 py-1"
                title={props.projectID ?? undefined}>Project: {props.projectNames?.[props.projectID!] ?? props.projectID}</span>
            </Show>
            <span>Producer-recorded · overlapping intervals</span>
          </div>
        </div>
        <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="Generating" value={totals().measuredGenerations ? formatDuration(totals().generationMs, unit) : "—"}
            sub="sum of measured stream intervals" tooltip="Additive across concurrent generations, not wall-clock elapsed time." />
          <Stat label="Average generation" value={avgGeneration() === undefined ? "—" : formatDuration(avgGeneration()!, unit)}
            sub={formatNumber(totals().measuredGenerations, unit) + " measured"} />
          <Stat label="Average end-to-end" value={avgWall() === undefined ? "—" : formatDuration(avgWall()!, unit)}
            sub={formatNumber(totals().wallRecords, unit) + " measured"} />
          <Stat label="Time to first token" value={ttft() === undefined ? "—" : formatDuration(ttft()!, unit)}
            sub={scope().level === "global" ? "global measured mean" : "see scoped host TTFT"}
            tooltip="The summary provides global TTFT only; per-cohort P50/P95 appears below from the separate workload projection. Provider-internal TTFT is unobserved." />
          <Stat label="Generated throughput" value={tps() === undefined ? "—" : formatTokensPerSecond(tps()!, unit)}
            sub="output + reasoning / generating" />
          <Stat label="Cache-read share" value={readShare() === undefined ? "—" : formatPercent(readShare()!, unit)}
            meter={readShare()} sub="cached / (fresh + cached)" />
        </RuleGrid>
      </Panel>

      <Show when={scope().level !== "model"} fallback={
        <Show when={selectedModel()}>
          {(row) => (
            <Panel title="Model profile" accessory={<span class="text-[10px] text-v2-text-text-faint">exact provider + model identity</span>} flush>
              <div class="grid grid-cols-2 gap-px bg-[var(--usage-line)] sm:grid-cols-4">
                <For each={[
                  ["Provider", row().providerID],
                  ["Model", row().modelID ?? "—"],
                  ["Recorded calls", formatNumber(row().generations, unit)],
                  ["Timing coverage", row().generations ? formatPercent(row().measuredGenerations / row().generations, unit) : "—"],
                  ["Fresh input", formatNumber(row().input, unit)],
                  ["Cache reads", formatNumber(row().cacheRead, unit)],
                  ["Output", formatNumber(row().output, unit)],
                  ["Reasoning", formatNumber(row().reasoning, unit)],
                ] as const}>{([label, value]) =>
                  <div class="min-w-0 bg-[var(--usage-panel)] px-3 py-2">
                    <div class="text-[9px] font-[570] uppercase tracking-[0.04em] text-v2-text-text-faint">{label}</div>
                    <div class="mt-1 truncate text-[11px] font-[590] tabular-nums text-v2-text-text-base" title={value}>{value}</div>
                  </div>
                }</For>
              </div>
              <p class="px-3 py-2 text-[10px] leading-4 text-v2-text-text-faint">
                The tool, latency and project rankings below are restricted to this exact provider + model identity and active date/project filters.
                Missing historical tool settlements are not interpreted as zero activity.
              </p>
            </Panel>
          )}
        </Show>
      }>
        <Panel title={scope().level === "global" ? "Providers · global" : "Models · " + scope().providerID}
          accessory={<span class="text-[10px] tabular-nums text-v2-text-text-faint">{visible().length} of {children().length} · sort: {order()}</span>} flush>
          <div class="flex min-h-9 items-center gap-3 border-b border-[var(--usage-line)] px-3">
            <span class="text-[10px] font-[590] text-v2-text-text-muted">
              {scope().level === "global" ? "Select a provider to explore its models" : "Select a model for its tools, projects and timing"}
            </span>
            <input type="search" aria-label={scope().level === "global" ? "Find provider" : "Find model"}
              value={search()} onInput={(event) => setSearch(event.currentTarget.value)}
              placeholder={scope().level === "global" ? "Find provider…" : "Find model…"}
              class="ml-auto h-6 w-44 rounded-[5px] border border-[var(--usage-line)] bg-v2-background-bg-layer-02 px-2 text-[11px] text-v2-text-text-base placeholder:text-v2-text-text-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-text-text-accent" />
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[700px] border-collapse text-[11px] tabular-nums">
              <thead class="bg-v2-background-bg-layer-02 text-[10px] text-v2-text-text-faint">
                <tr class="h-7 border-b border-[var(--usage-line)]">
                  <th scope="col" class="px-3 text-left font-[550]">{scope().level === "global" ? "Provider" : "Model"}</th>
                  <For each={[
                    ["calls", "Calls"], ["generation", "Generating"], ["latency", "Avg. generation"],
                    ["throughput", "Output/s"], ["cache", "Cache read"],
                  ] as const}>{([key, label]) =>
                    <th scope="col" aria-sort={order() === key ? "descending" : "none"} class="px-2 text-right font-[550]">
                      <button type="button" class="cursor-pointer whitespace-nowrap hover:text-v2-text-text-base"
                        onClick={() => setOrder(key)}>{label}{order() === key ? " ↓" : ""}</button>
                    </th>
                  }</For>
                  <th scope="col" class="px-3 text-right font-[550]">Coverage</th>
                </tr>
              </thead>
              <tbody>
                <For each={visible().slice(0, MAX_ROWS)}>{(item) => (
                  <tr class="h-7 border-b border-[var(--usage-line)] hover:bg-v2-background-bg-layer-02">
                    <td class="max-w-96 truncate px-3 font-[550] text-v2-text-text-base">
                      <button type="button" class="group flex max-w-full items-center gap-2 truncate text-left focus-visible:underline"
                        title={item.modelID ?? item.providerID}
                        onClick={() => navigate(item.modelID ? usageModelScope(item.providerID, item.modelID) : usageProviderScope(item.providerID))}>
                        <span class="truncate group-hover:underline">{item.modelID ?? item.providerID}</span>
                        <span aria-hidden="true" class="shrink-0 text-[10px] text-v2-text-text-faint opacity-40 group-hover:opacity-100">›</span>
                      </button>
                    </td>
                    <td class="px-2 text-right"><Value value={item.generations} /></td>
                    <td class="px-2 text-right"><Value value={item.measuredGenerations ? item.generationMs : undefined} kind="time" /></td>
                    <td class="px-2 text-right"><Value value={averageMeasured(item.generationMs, item.measuredGenerations)} kind="time" /></td>
                    <td class="px-2 text-right"><Value value={outputThroughput(item)} kind="rate" /></td>
                    <td class="px-2 text-right"><Value value={cacheRate(item)} kind="percent" /></td>
                    <td class="px-3 text-right text-v2-text-text-faint">
                      <Value value={item.generations ? item.measuredGenerations / item.generations : undefined} kind="percent" />
                    </td>
                  </tr>
                )}</For>
              </tbody>
            </table>
          </div>
          <Show when={visible().length > MAX_ROWS}>
            <div class="border-t border-[var(--usage-line)] px-3 py-2 text-[10px] text-v2-text-text-faint">
              Showing {MAX_ROWS} of {visible().length}. Refine the quick filter to inspect additional cohorts.
            </div>
          </Show>
          <Show when={!visible().length}>
            <div class="px-3 py-6 text-center text-[11px] text-v2-text-text-faint">No matching settled cohorts in the current time/project range.</div>
          </Show>
        </Panel>
      </Show>

      <UsageWorkloadPanel value={currentWorkload()} loading={workload.loading || (!workload.error && !currentWorkload())}
        error={workload.error} projectNames={props.projectNames} onProjectSelect={props.onProjectSelect}
        onModelSelect={(providerID, modelID) => navigate(usageModelScope(providerID, modelID))} />
    </div>
  )
}
