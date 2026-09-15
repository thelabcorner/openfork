import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import {
  browserHostClient,
  type VisualArtifactDescriptor,
  type VisualArtifactInput,
  type VisualArtifactKind,
  type VisualBaselineSummary,
  type VisualHistory,
  type VisualRunSummary,
} from "./browserHostClient"
import { VisualPreviewCache, decodeVisualJson } from "./visualPreview"

type Selection =
  | { kind: "run"; run: VisualRunSummary }
  | { kind: "baseline"; baseline: VisualBaselineSummary }

type VisualEnvironment = {
  lane?: string
  platform?: string
  engine?: string
  engineMajor?: number
  appearance?: string
  snapeyeVersion?: string
  snapdomVersion?: string
  redactionPolicySha256?: string
}

type VisualTerminalResult = {
  runId: string
  status: "ok" | "error"
  operation: "capture" | "diff" | "record"
  name?: string
  target?: { selector?: string; descriptor?: string }
  finishedAt?: string
  image?: { cssWidth?: number; cssHeight?: number; pixelWidth?: number; pixelHeight?: number; scale?: number }
  timing?: { captureMs?: number }
  diff?: {
    changed?: boolean
    changedRatio?: number
    regionCount?: number
    regionsTruncated?: boolean
    regions?: Array<{ x: number; y: number; width: number; height: number; aggregate?: boolean }>
  }
  record?: {
    durationActualMs?: number
    fpsActual?: number
    frameCount?: number
    format?: string
  }
  error?: { code?: string; message?: string }
  opencode?: VisualEnvironment
}

type DetailState = {
  loading: boolean
  error?: string
  baselineUrl?: string | null
  currentUrl?: string | null
  diffUrl?: string | null
  framesUrl?: string | null
  gifUrl?: string | null
  result?: VisualTerminalResult | null
  baselineMetadata?: Record<string, unknown> | null
  video?: VisualArtifactDescriptor | null
  baselineSha256?: string
  baselineMetadataSha256?: string | null
  currentSha256?: string
  resultSha256?: string
}

const EMPTY_HISTORY: VisualHistory = { root: ".snapeye", baselines: [], runs: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseTerminalResult(value: unknown): VisualTerminalResult | null {
  if (!isRecord(value)) return null
  if (typeof value.runId !== "string") return null
  if (value.status !== "ok" && value.status !== "error") return null
  if (value.operation !== "capture" && value.operation !== "diff" && value.operation !== "record") return null
  return value as VisualTerminalResult
}

function baselineEnvironment(metadata: Record<string, unknown> | null | undefined): VisualEnvironment | null {
  const environment = metadata?.opencode
  return isRecord(environment) ? (environment as VisualEnvironment) : null
}

function artifactInput(runId: string, artifact: "current" | "diff" | "frames" | "gif" | "video" | "result"): VisualArtifactInput {
  return { source: "run", runId, artifact }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(value?: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function shortDigest(value?: string): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "none"
}

export function VisualInspector(props: { onClose: () => void }) {
  const language = useLanguage()
  const cache = new VisualPreviewCache()
  const [history, setHistory] = createSignal<VisualHistory>(EMPTY_HISTORY)
  const [selection, setSelection] = createSignal<Selection | null>(null)
  const [detail, setDetail] = createSignal<DetailState>({ loading: false })
  const [loadingHistory, setLoadingHistory] = createSignal(false)
  const [historyError, setHistoryError] = createSignal<string>()
  const [approving, setApproving] = createSignal(false)
  let detailGeneration = 0
  let historyGeneration = 0

  const projectAvailable = createMemo(() => browserHostClient.visualProjectContext() !== null)

  const chooseDefault = (next: VisualHistory, previous: Selection | null): Selection | null => {
    if (previous?.kind === "run") {
      const run = next.runs.find((candidate) => candidate.runId === previous.run.runId)
      if (run) return { kind: "run", run }
    }
    if (previous?.kind === "baseline") {
      const baseline = next.baselines.find((candidate) => candidate.name === previous.baseline.name)
      if (baseline) return { kind: "baseline", baseline }
    }
    const run = next.runs[0]
    if (run) return { kind: "run", run }
    const baseline = next.baselines[0]
    return baseline ? { kind: "baseline", baseline } : null
  }

  const refresh = async () => {
    const generation = ++historyGeneration
    if (!projectAvailable()) {
      setHistory(EMPTY_HISTORY)
      setSelection(null)
      setHistoryError(language.t("browser.visual.requiresSession"))
      return
    }
    setLoadingHistory(true)
    setHistoryError(undefined)
    try {
      const next = await browserHostClient.visualHistory({ maxRuns: 40, maxBaselines: 80 })
      if (generation !== historyGeneration) return
      const previous = selection()
      setHistory(next)
      setSelection(chooseDefault(next, previous))
    } catch (error) {
      if (generation !== historyGeneration) return
      setHistoryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === historyGeneration) setLoadingHistory(false)
    }
  }

  const loadPreview = async (key: string, input: VisualArtifactInput, generation: number): Promise<{ url: string | null; sha256: string } | null> => {
    const preview = await browserHostClient.visualArtifactPreview(input)
    if (generation !== detailGeneration) return null
    return preview ? { url: cache.replace(key, preview), sha256: preview.sha256 } : null
  }

  const loadDetail = async (selected: Selection | null) => {
    const generation = ++detailGeneration
    cache.clearAll()
    if (!selected) {
      setDetail({ loading: false })
      return
    }
    setDetail({ loading: true })
    try {
      if (selected.kind === "baseline") {
        const [baselinePreview, metadataPreview] = await Promise.all([
          loadPreview("baseline", { source: "baseline", name: selected.baseline.name }, generation),
          browserHostClient.visualArtifactPreview({ source: "baseline", name: selected.baseline.name, artifact: "metadata" }).catch(() => null),
        ])
        if (generation !== detailGeneration) return
        const metadata = decodeVisualJson(metadataPreview)
        setDetail({
          loading: false,
          baselineUrl: baselinePreview?.url ?? null,
          baselineMetadata: isRecord(metadata) ? metadata : null,
        })
        return
      }

      const run = selected.run
      const has = (kind: VisualArtifactKind) => run.artifacts.includes(kind)
      // Only diff review needs the complete baseline pair for optimistic
      // approval. Capture review benefits from showing the resulting baseline
      // image, while record review has no baseline-comparison UI at all. Avoid
      // cloning baseline PNG/metadata into the renderer for record selections.
      const loadBaselineImage = run.operation === "capture" || run.operation === "diff"
      const loadBaselineMetadata = run.operation === "diff"
      const [resultPreview, baselinePreview, baselineMetadataPreview, currentPreview, diffPreview, framesPreview, gifPreview, video] = await Promise.all([
        browserHostClient.visualArtifactPreview(artifactInput(run.runId, "result")),
        run.name && loadBaselineImage ? loadPreview("baseline", { source: "baseline", name: run.name }, generation) : Promise.resolve(null),
        run.name && loadBaselineMetadata ? browserHostClient.visualArtifactPreview({ source: "baseline", name: run.name, artifact: "metadata" }) : Promise.resolve(null),
        has("current") ? loadPreview("current", artifactInput(run.runId, "current"), generation) : Promise.resolve(null),
        has("diff") ? loadPreview("diff", artifactInput(run.runId, "diff"), generation) : Promise.resolve(null),
        has("frames") ? loadPreview("frames", artifactInput(run.runId, "frames"), generation) : Promise.resolve(null),
        has("gif") ? loadPreview("gif", artifactInput(run.runId, "gif"), generation) : Promise.resolve(null),
        has("video") ? browserHostClient.visualArtifact(artifactInput(run.runId, "video")).catch(() => null) : Promise.resolve(null),
      ])
      if (generation !== detailGeneration) return
      setDetail({
        loading: false,
        baselineUrl: baselinePreview?.url ?? null,
        currentUrl: currentPreview?.url ?? null,
        diffUrl: diffPreview?.url ?? null,
        framesUrl: framesPreview?.url ?? null,
        gifUrl: gifPreview?.url ?? null,
        result: parseTerminalResult(decodeVisualJson(resultPreview)),
        video,
        baselineSha256: baselinePreview?.sha256,
        baselineMetadataSha256: baselineMetadataPreview?.sha256 ?? null,
        currentSha256: currentPreview?.sha256,
        resultSha256: resultPreview?.sha256,
      })
    } catch (error) {
      if (generation !== detailGeneration) return
      setDetail({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  createEffect(() => {
    void refresh()
  })

  createEffect(() => {
    void loadDetail(selection())
  })

  onCleanup(() => {
    historyGeneration += 1
    detailGeneration += 1
    cache.clearAll()
  })

  const selectedRun = createMemo(() => selection()?.kind === "run" ? (selection() as { kind: "run"; run: VisualRunSummary }).run : null)
  const environment = createMemo(() => detail().result?.opencode ?? baselineEnvironment(detail().baselineMetadata))
  const canApprove = createMemo(() => {
    const run = selectedRun()
    const reviewed = detail()
    return !!run &&
      run.status === "ok" &&
      run.operation === "diff" &&
      run.artifacts.includes("current") &&
      !!reviewed.baselineSha256 &&
      reviewed.baselineMetadataSha256 !== undefined &&
      !!reviewed.currentSha256 &&
      !!reviewed.resultSha256
  })

  const approve = async () => {
    const run = selectedRun()
    if (!run || !canApprove() || approving()) return
    setApproving(true)
    try {
      const reviewed = detail()
      if (!reviewed.currentSha256 || !reviewed.resultSha256 || !reviewed.baselineSha256 || reviewed.baselineMetadataSha256 === undefined) return
      const approved = await browserHostClient.visualApproveRun(run.runId, {
        currentSha256: reviewed.currentSha256,
        resultSha256: reviewed.resultSha256,
        baselineSha256: reviewed.baselineSha256,
        baselineMetadataSha256: reviewed.baselineMetadataSha256,
      })
      showToast({ title: language.t("browser.visual.approved"), description: approved.baseline.name })
      await refresh()
      await loadDetail(selection())
    } catch (error) {
      showToast({
        title: language.t("browser.visual.approveFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApproving(false)
    }
  }

  return (
    <section class="flex h-[46%] min-h-[240px] max-h-[520px] shrink-0 flex-col border-t border-v2-border-border-base bg-v2-background-bg-base" data-browser-visual-inspector>
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base px-2">
        <IconV2 name="compare" class="size-3.5 text-v2-icon-icon-muted" />
        <span class="text-[11px] font-medium text-v2-text-text-base">{language.t("browser.visual.title")}</span>
        <Show when={history().runs.length || history().baselines.length}>
          <span class="text-[10px] tabular-nums text-v2-text-text-muted">
            {history().baselines.length}B · {history().runs.length}R
          </span>
        </Show>
        <div class="flex-1" />
        <TooltipV2 value={language.t("browser.visual.refresh")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            disabled={loadingHistory()}
            onClick={() => void refresh()}
            aria-label={language.t("browser.visual.refresh")}
            icon={<IconV2 name="reset" />}
          />
        </TooltipV2>
        <TooltipV2 value={language.t("common.close")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            onClick={props.onClose}
            aria-label={language.t("common.close")}
            icon={<IconV2 name="xmark-small" />}
          />
        </TooltipV2>
      </div>

      <Show
        when={projectAvailable()}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11px] leading-relaxed text-v2-text-text-muted">
            {language.t("browser.visual.requiresSession")}
          </div>
        }
      >
        <div class="grid min-h-0 flex-1 grid-cols-[138px_minmax(0,1fr)]">
          <aside class="min-h-0 overflow-y-auto border-r border-v2-border-border-base p-1.5">
            <div class="mb-1 px-1 text-[9px] font-medium uppercase tracking-[0.08em] text-v2-text-text-muted">
              {language.t("browser.visual.baselines")}
            </div>
            <Show when={history().baselines.length > 0} fallback={<EmptyRow text={language.t("browser.visual.none")} />}>
              <For each={history().baselines}>
                {(baseline) => (
                  <NavRow
                    active={selection()?.kind === "baseline" && (selection() as { kind: "baseline"; baseline: VisualBaselineSummary }).baseline.name === baseline.name}
                    title={baseline.name}
                    meta={`${formatBytes(baseline.byteLength)}${baseline.lane ? ` · ${baseline.lane}` : ""}`}
                    onClick={() => setSelection({ kind: "baseline", baseline })}
                  />
                )}
              </For>
            </Show>

            <div class="mb-1 mt-3 px-1 text-[9px] font-medium uppercase tracking-[0.08em] text-v2-text-text-muted">
              {language.t("browser.visual.runs")}
            </div>
            <Show when={history().runs.length > 0} fallback={<EmptyRow text={language.t("browser.visual.none")} />}>
              <For each={history().runs}>
                {(run) => (
                  <NavRow
                    active={selection()?.kind === "run" && (selection() as { kind: "run"; run: VisualRunSummary }).run.runId === run.runId}
                    title={run.name ?? run.runId}
                    meta={`${run.operation}${run.operation === "diff" ? ` · ${run.changed ? "changed" : "same"}` : run.frameCount ? ` · ${run.frameCount}f` : ""}`}
                    tone={run.status === "error" ? "danger" : run.changed ? "warning" : "neutral"}
                    onClick={() => setSelection({ kind: "run", run })}
                  />
                )}
              </For>
            </Show>
          </aside>

          <main class="min-h-0 overflow-y-auto">
            <Show when={!loadingHistory()} fallback={<CenteredStatus text={language.t("browser.visual.loading")} />}>
              <Show when={!historyError()} fallback={<CenteredStatus text={historyError() ?? ""} danger />}>
                <Show when={selection()} fallback={<CenteredStatus text={language.t("browser.visual.none")} />}>
                  <VisualDetail
                    selection={selection()!}
                    detail={detail()}
                    environment={environment()}
                    canApprove={canApprove()}
                    approving={approving()}
                    onApprove={() => void approve()}
                  />
                </Show>
              </Show>
            </Show>
          </main>
        </div>
      </Show>
    </section>
  )
}

function NavRow(props: {
  active: boolean
  title: string
  meta: string
  tone?: "neutral" | "warning" | "danger"
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-active={props.active || undefined}
      class="mb-0.5 flex w-full min-w-0 flex-col rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-v2-background-bg-layer-02 data-[active=true]:bg-v2-background-bg-layer-03"
      onClick={props.onClick}
    >
      <span class="w-full truncate text-[10px] font-medium text-v2-text-text-base">{props.title}</span>
      <span
        class="w-full truncate text-[9px] text-v2-text-text-muted"
        classList={{
          "text-v2-text-text-warning": props.tone === "warning",
          "text-v2-text-text-danger": props.tone === "danger",
        }}
      >
        {props.meta}
      </span>
    </button>
  )
}

function EmptyRow(props: { text: string }) {
  return <div class="px-1 py-1 text-[9px] text-v2-text-text-muted">{props.text}</div>
}

function CenteredStatus(props: { text: string; danger?: boolean }) {
  return (
    <div
      class="flex min-h-full items-center justify-center p-4 text-center text-[10px] leading-relaxed text-v2-text-text-muted"
      classList={{ "text-v2-text-text-danger": props.danger }}
    >
      {props.text}
    </div>
  )
}

function VisualDetail(props: {
  selection: Selection
  detail: DetailState
  environment: VisualEnvironment | null | undefined
  canApprove: boolean
  approving: boolean
  onApprove: () => void
}) {
  const language = useLanguage()
  const result = () => props.detail.result
  const run = () => props.selection.kind === "run" ? props.selection.run : null
  const baseline = () => props.selection.kind === "baseline" ? props.selection.baseline : null
  const diff = () => result()?.diff
  const regions = () => diff()?.regions ?? []
  const environment = () => props.environment

  return (
    <div class="flex min-h-full flex-col gap-2 p-2">
      <div class="flex min-w-0 items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="truncate text-[11px] font-medium text-v2-text-text-base">
            {run()?.name ?? baseline()?.name ?? run()?.runId}
          </div>
          <div class="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-v2-text-text-muted">
            <Show when={run()}>{(value) => <span>{value().operation} · {value().runId}</span>}</Show>
            <Show when={baseline()}>{(value) => <span>{formatBytes(value().byteLength)} · {formatTimestamp(value().capturedAt)}</span>}</Show>
            <Show when={result()?.target?.selector}><span>{result()?.target?.selector}</span></Show>
          </div>
        </div>
        <Show when={props.canApprove}>
          <button
            type="button"
            disabled={props.approving}
            class="h-6 shrink-0 rounded-[4px] bg-v2-background-bg-layer-03 px-2 text-[10px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
            onClick={props.onApprove}
            title={language.t("browser.visual.approveExact")}
          >
            {props.approving ? language.t("browser.visual.approving") : language.t("browser.visual.approve")}
          </button>
        </Show>
      </div>

      <Show when={props.detail.loading}>
        <div class="text-[10px] text-v2-text-text-muted">{language.t("browser.visual.loading")}</div>
      </Show>
      <Show when={props.detail.error}>
        <div class="rounded-[4px] border border-v2-text-text-danger/30 bg-v2-background-bg-layer-01 p-2 text-[10px] text-v2-text-text-danger">
          {props.detail.error}
        </div>
      </Show>

      <div class="flex min-w-0 gap-2 overflow-x-auto pb-1">
        <Show when={props.detail.baselineUrl}>
          {(url) => <PreviewCard label={language.t("browser.visual.baseline")} url={url()} />}
        </Show>
        <Show when={props.detail.currentUrl}>
          {(url) => <PreviewCard label={language.t("browser.visual.current")} url={url()} />}
        </Show>
        <Show when={props.detail.diffUrl}>
          {(url) => <PreviewCard label={language.t("browser.visual.diff")} url={url()} />}
        </Show>
      </div>

      <Show when={diff()}>
        {(value) => (
          <section class="rounded-[5px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
              <span class={value().changed ? "font-medium text-v2-text-text-warning" : "font-medium text-v2-text-text-base"}>
                {value().changed ? language.t("browser.visual.changed") : language.t("browser.visual.unchanged")}
              </span>
              <span class="tabular-nums text-v2-text-text-muted">
                {typeof value().changedRatio === "number" ? `${(value().changedRatio! * 100).toFixed(4)}%` : "—"}
              </span>
              <span class="tabular-nums text-v2-text-text-muted">
                {value().regionCount ?? regions().length} {language.t("browser.visual.regions")}
              </span>
              <Show when={result()?.timing?.captureMs != null}>
                <span class="tabular-nums text-v2-text-text-muted">{result()?.timing?.captureMs} ms</span>
              </Show>
            </div>
            <Show when={regions().length > 0}>
              <div class="mt-1.5 max-h-16 overflow-y-auto font-mono text-[8px] leading-4 text-v2-text-text-muted">
                <For each={regions().slice(0, 12)}>
                  {(region, index) => (
                    <div>
                      #{index() + 1} x={region.x} y={region.y} w={region.width} h={region.height}{region.aggregate ? " aggregate" : ""}
                    </div>
                  )}
                </For>
                <Show when={value().regionsTruncated || regions().length > 12}>
                  <div>…</div>
                </Show>
              </div>
            </Show>
          </section>
        )}
      </Show>

      <Show when={props.detail.framesUrl}>
        {(url) => (
          <section class="rounded-[5px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-v2-text-text-muted">
              <span>{language.t("browser.visual.filmstrip")}</span>
              <Show when={result()?.record}>
                {(record) => (
                  <span class="tabular-nums">
                    {record().frameCount ?? "?"}f · {record().durationActualMs ?? "?"}ms · {typeof record().fpsActual === "number" ? record().fpsActual!.toFixed(1) : "?"}fps
                  </span>
                )}
              </Show>
            </div>
            <img src={url()} alt={language.t("browser.visual.filmstrip")} class="max-h-40 w-full rounded-[3px] object-contain" />
          </section>
        )}
      </Show>

      <Show when={props.detail.gifUrl}>
        {(url) => <PreviewCard label="GIF" url={url()} wide />}
      </Show>
      <Show when={props.detail.video}>
        {(video) => (
          <div class="truncate text-[9px] text-v2-text-text-muted" title={video().path}>
            Video · {formatBytes(video().byteLength)} · {video().path}
          </div>
        )}
      </Show>

      <Show when={environment()}>
        {(env) => (
          <section class="grid grid-cols-2 gap-x-3 gap-y-1 rounded-[5px] border border-v2-border-border-base px-2 py-1.5 text-[9px] text-v2-text-text-muted">
            <Meta label={language.t("browser.visual.environment")} value={`${env().lane ?? "?"} · ${env().engine ?? "chromium"}${env().engineMajor ? ` ${env().engineMajor}` : ""}`} />
            <Meta label="Platform" value={env().platform ?? "—"} />
            <Meta label="SnapEye" value={env().snapeyeVersion ?? "—"} />
            <Meta label="SnapDOM" value={env().snapdomVersion ?? "—"} />
            <Meta label="Appearance" value={env().appearance ?? "—"} />
            <Meta label={language.t("browser.visual.redaction")} value={shortDigest(env().redactionPolicySha256)} title={env().redactionPolicySha256} />
          </section>
        )}
      </Show>

      <Show when={result()?.status === "error" && result()?.error}>
        <div class="rounded-[5px] border border-v2-text-text-danger/30 p-2 text-[9px] text-v2-text-text-danger">
          {result()?.error?.code}: {result()?.error?.message}
        </div>
      </Show>
    </div>
  )
}

function PreviewCard(props: { label: string; url: string; wide?: boolean }) {
  return (
    <figure class={props.wide ? "min-w-[260px] flex-1" : "w-[180px] shrink-0"}>
      <figcaption class="mb-1 text-[9px] font-medium text-v2-text-text-muted">{props.label}</figcaption>
      <div class="flex h-28 items-center justify-center overflow-hidden rounded-[5px] border border-v2-border-border-base bg-v2-background-bg-layer-01">
        <img src={props.url} alt={props.label} class="max-h-full max-w-full object-contain" />
      </div>
    </figure>
  )
}

function Meta(props: { label: string; value: string; title?: string }) {
  return (
    <div class="min-w-0" title={props.title ?? props.value}>
      <span class="text-v2-text-text-muted">{props.label}: </span>
      <span class="truncate text-v2-text-text-base">{props.value}</span>
    </div>
  )
}
