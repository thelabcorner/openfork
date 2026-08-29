import { createMemo, createEffect, createSignal, on, onCleanup, For, Show } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/core/util/encode"
import { findLast } from "@opencode-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { AccordionV2 } from "@opencode-ai/ui/v2/accordion-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { ProgressCircleV2 } from "@opencode-ai/ui/v2/progress-circle-v2"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/utils/session-export"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { formatCostPerMillion } from "@/components/model-tooltip"
import { getSessionContext } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import {
  aggregateSessionContextByModel,
  liveGenerationProgress,
  modelKey,
  type CostBreakdown,
  type LiveGenerationProgress,
  type ModelContextMetrics,
  type ModelCostRate,
} from "./session-context-model-metrics"
import { createSessionContextFormatter } from "./session-context-format"
import { MetricCell, Section } from "./insights-primitives"

const emptyLiveProgress: LiveGenerationProgress = { generatedSeconds: 0, toolSeconds: 0 }
const emptySessionParts: Record<string, Part[] | undefined> = {}
const emptyProviderList: Parameters<typeof aggregateSessionContextByModel>[2] = []

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

const TOKEN_COLOR = {
  input: "var(--syntax-info)",
  output: "var(--syntax-success)",
  reasoning: "var(--syntax-property)",
  cacheRead: "var(--syntax-warning)",
  cacheWrite: "var(--syntax-constant)",
}

const COST_COLOR = {
  input: TOKEN_COLOR.input,
  output: TOKEN_COLOR.output,
  cacheRead: TOKEN_COLOR.cacheRead,
  cacheWrite: TOKEN_COLOR.cacheWrite,
}

type CategorySegment = { key: string; label: string; amount: number; color: string; display: string }


function InfoCard(props: { children: JSX.Element }) {
  return <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">{props.children}</div>
}

function InfoRow(props: { label: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-2 border-b border-v2-border-border-muted px-2 py-1 last:border-0">
      <span class="shrink-0 text-[10px] font-[440] leading-3.5 text-v2-text-text-muted">{props.label}</span>
      <span class="min-w-0 truncate text-right text-[10px] font-[520] leading-3.5 text-v2-text-text-base">
        {props.value}
      </span>
    </div>
  )
}

function RatioBar(props: { percent: number | null; color: string }) {
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03">
      <div
        class="h-full rounded-full transition-[width]"
        style={{
          width: `${Math.max(0, Math.min(100, props.percent ?? 0))}%`,
          "background-color": props.color,
          opacity: props.percent === null ? 0.25 : 1,
        }}
      />
    </div>
  )
}

function CategoryBar(props: { segments: CategorySegment[] }) {
  const visible = () => props.segments.filter((segment) => segment.amount > 0)
  const total = () => props.segments.reduce((sum, segment) => sum + segment.amount, 0)
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex h-2 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03">
        <For each={visible()}>
          {(segment) => (
            <div
              class="h-full"
              style={{
                width: `${total() > 0 ? (segment.amount / total()) * 100 : 0}%`,
                "background-color": segment.color,
              }}
            />
          )}
        </For>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1">
        <For each={visible()}>
          {(segment) => (
            <div class="flex items-center gap-1 text-[10px] font-[440] leading-3 text-v2-text-text-muted">
              <div class="size-2 shrink-0 rounded-sm" style={{ "background-color": segment.color }} />
              <span>{segment.label}</span>
              <span class="tabular-nums text-v2-text-text-faint">{segment.display}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

const PREVIEW_LENGTH = 24

/** First 24 chars of the message's own visible content — text first, reasoning as a fallback. */
function messagePreviewText(parts: Part[]): string | undefined {
  const firstNonEmpty = (predicate: (part: Part) => string | undefined) => {
    for (const part of parts) {
      const text = predicate(part)
      if (text === undefined) continue
      const trimmed = text.trim()
      if (trimmed) return trimmed
    }
    return undefined
  }

  const text =
    firstNonEmpty((part) => (part.type === "text" && !part.synthetic && !part.ignored ? part.text : undefined)) ??
    firstNonEmpty((part) => (part.type === "reasoning" ? part.text : undefined))
  if (!text) return undefined
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab(props: { active?: Accessor<boolean> }) {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const platform = usePlatform()
  const local = useLocal()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()
  const active = () => props.active?.() ?? true

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo<Message[]>(
    (previous) => {
      if (!active()) return previous
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      const boundary = userMessages().findIndex((message) => message.id === revert)
      return boundary < 0 ? userMessages() : userMessages().slice(0, boundary)
    },
    emptyUserMessages,
    { equals: same },
  )

  // Reading the whole part store makes this pane invalidate for every
  // session's streaming delta. Keep a narrow projection of only the active
  // session's message parts instead.
  const sessionParts = createMemo<Record<string, Part[] | undefined>>((previous) => {
    if (!active()) return previous
    const all = sync().data.part
    const result: Record<string, Part[] | undefined> = {}
    for (const message of messages()) result[message.id] = all[message.id] as Part[] | undefined
    return result
  }, emptySessionParts)

  const providerList = createMemo<Parameters<typeof aggregateSessionContextByModel>[2]>((previous) => {
    if (!active()) return previous
    return [...providers.all().values()]
  }, emptyProviderList)

  const ctx = createMemo(() => getSessionContext(messages(), providerList()))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const [rawOpen, setRawOpen] = createSignal<string[]>([])

  // Reset accordion open state + gate live timer on session/tab switch (prevents
  // stale teardown and effect churn for inactive tabs after keep-mounted shell).
  createEffect(
    on(
      () => params.id,
      (current, previous) => {
        if (current !== previous) setRawOpen([])
      },
    ),
  )

  // The turn currently streaming (if any) — last assistant message without
  // `time.completed`. Drives the faux-realtime timing ticker below; a stable
  // primitive id (not the message object) is what the effect tracks, so a
  // mid-turn token-count update doesn't tear down and restart the interval.
  const liveMessage = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role !== "assistant") continue
      return msg.time.completed ? undefined : (msg as AssistantMessage)
    }
    return undefined
  })
  const liveMessageID = createMemo(() => liveMessage()?.id)

  // Compaction runs server-side as an ordinary streaming assistant turn tagged
  // mode/agent "compaction", so the message store is the only truthful progress
  // signal; everything between click and first stream event is optimistic.
  const [compactQueued, setCompactQueued] = createSignal(false)
  const liveCompaction = createMemo(() => {
    const msg = liveMessage()
    return !!msg && (msg.mode === "compaction" || msg.agent === "compaction")
  })
  const compactBusy = () => compactQueued() || liveCompaction()

  // Tiny sessions can finish before the streaming summary is ever observed;
  // release the optimistic pending state after a short grace instead of
  // spinning forever.
  let compactGrace: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(liveCompaction, (active) => {
      if (!active) return
      if (compactGrace !== undefined) {
        clearTimeout(compactGrace)
        compactGrace = undefined
      }
      setCompactQueued(false)
    }),
  )
  onCleanup(() => {
    if (compactGrace !== undefined) clearTimeout(compactGrace)
  })

  const compactSession = async () => {
    const sessionID = params.id
    if (!sessionID || compactBusy()) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    setCompactQueued(true)
    try {
      await sdk().api.session.compact({
        sessionID,
        model: { providerID: model.providerID, modelID: model.id },
      })
      if (!liveCompaction() && compactGrace === undefined) {
        compactGrace = setTimeout(() => {
          compactGrace = undefined
          setCompactQueued(false)
        }, 2000)
      }
    } catch (err) {
      setCompactQueued(false)
      showToast({
        variant: "error",
        title: language.t("toast.session.compact.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.compact.failed.description"),
      })
    }
  }

  const compactDisabled = () => !params.id || visibleUserMessages().length === 0 || compactBusy()

  const [now, setNow] = createSignal(Date.now())
  createEffect(
    on(
      () => [active(), liveMessageID()] as const,
      ([isActive, id]) => {
        if (!isActive || !id) return
        setNow(Date.now())
        const interval = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(interval))
      },
    ),
  )

  const liveDelta = createMemo<LiveGenerationProgress>(() => {
    const msg = liveMessage()
    if (!msg) return emptyLiveProgress
    return liveGenerationProgress(msg, sessionParts()[msg.id], now())
  })

  const liveDeltaFor = (metrics: ModelContextMetrics): LiveGenerationProgress => {
    const msg = liveMessage()
    if (!msg || modelKey(msg) !== metrics.key) return emptyLiveProgress
    return liveDelta()
  }

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt(), sessionParts()] as const,
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sessionParts(),
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const overviewStats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const usagePercent = createMemo(() => ctx()?.usage ?? null)

  const aggregate = createMemo(
    on(
      () => [messages(), sessionParts(), providerList()] as const,
      ([msgs, parts, list]) => aggregateSessionContextByModel(msgs, parts, list),
    ),
  )

  const session = createMemo(() => aggregate().session)
  const models = createMemo(() => aggregate().models)

  const sessionTotalsStats = [
    { label: "context.stats.totalTokens", value: () => formatter().number(session().total) },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.metric.toolCalls", value: () => session().toolCallCount.toLocaleString(language.intl()) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const modelMetricStats = (metrics: ModelContextMetrics, live: LiveGenerationProgress) =>
    [
      { label: "context.stats.totalTokens", value: () => formatter().number(metrics.total), live: false },
      { label: "context.stats.totalCost", value: () => formatter().currency(metrics.cost), live: false },
      { label: "context.stats.messages", value: () => metrics.messageCount.toLocaleString(language.intl()), live: false },
      {
        label: "context.metric.toolCalls",
        value: () => metrics.toolCallCount.toLocaleString(language.intl()),
        live: false,
      },
      {
        label: "context.metric.generatedTime",
        value: () => durationLabel(metrics.generatedSeconds + live.generatedSeconds),
        live: live.generatedSeconds > 0,
      },
      {
        label: "context.metric.toolTime",
        value: () => durationLabel(metrics.toolSeconds + live.toolSeconds),
        live: live.toolSeconds > 0,
      },
      { label: "context.metric.ttft", value: () => durationLabel(metrics.ttftSeconds), live: false },
      ...(metrics.cacheSavings !== undefined
        ? [{ label: "context.metric.cacheSavings", value: () => formatter().currency(metrics.cacheSavings), live: false }]
        : []),
    ] satisfies { label: string; value: () => JSX.Element; live: boolean }[]

  const buildTokenSegments = (tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }): CategorySegment[] => {
    if (tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite <= 0) return []
    return [
      { key: "input", label: language.t("context.metric.input"), amount: tokens.input, color: TOKEN_COLOR.input },
      { key: "output", label: language.t("context.metric.output"), amount: tokens.output, color: TOKEN_COLOR.output },
      {
        key: "reasoning",
        label: language.t("context.metric.reasoning"),
        amount: tokens.reasoning,
        color: TOKEN_COLOR.reasoning,
      },
      {
        key: "cacheRead",
        label: language.t("context.metric.cacheRead"),
        amount: tokens.cacheRead,
        color: TOKEN_COLOR.cacheRead,
      },
      {
        key: "cacheWrite",
        label: language.t("context.metric.cacheWrite"),
        amount: tokens.cacheWrite,
        color: TOKEN_COLOR.cacheWrite,
      },
    ].map((segment) => ({ ...segment, display: formatter().number(segment.amount) }))
  }

  const buildCostSegments = (breakdown: CostBreakdown | undefined): CategorySegment[] => {
    if (!breakdown) return []
    return [
      { key: "input", label: language.t("context.metric.input"), amount: breakdown.input, color: COST_COLOR.input },
      { key: "output", label: language.t("context.metric.output"), amount: breakdown.output, color: COST_COLOR.output },
      {
        key: "cacheRead",
        label: language.t("context.metric.cacheRead"),
        amount: breakdown.cacheRead,
        color: COST_COLOR.cacheRead,
      },
      {
        key: "cacheWrite",
        label: language.t("context.metric.cacheWrite"),
        amount: breakdown.cacheWrite,
        color: COST_COLOR.cacheWrite,
      },
    ].map((segment) => ({ ...segment, display: formatter().currency(segment.amount) }))
  }

  const exportSession = async () => {
    const sessionID = params.id
    if (!sessionID) return
    try {
      const data = await fetchSessionExport({
        sessionID,
        client: sdk().client,
      })
      const saved = await downloadSessionExport(
        sessionExportFilename(data.info),
        data,
        platform.compressExport?.bind(platform),
      )
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.session.export.success.title"),
        description: language.t("toast.session.export.success.description", { filename: saved }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.export.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.export.failed.description"),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => [active(), params.id, messages().length] as const,
      ([isActive]) => {
        if (!isActive) return
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  const percentLabel = (value: number | null) =>
    value === null ? language.t("context.metric.unavailable") : `${value.toLocaleString(language.intl())}%`

  const tokensPerSecondLabel = (value: number | null) =>
    value === null ? language.t("context.metric.unavailable") : formatter().tokensPerSecond(value)

  const durationLabel = (value: number | null) =>
    value === null ? language.t("context.metric.unavailable") : formatter().duration(value)

  const CostRateRow = (props: { label: string; rate: number }) => (
    <div class="flex items-baseline justify-between gap-2 px-2 py-1">
      <span class="min-w-0 truncate text-[10px] font-[440] leading-3.5 text-v2-text-text-muted">{props.label}</span>
      <span class="shrink-0 text-right text-[10px] font-[520] tabular-nums leading-3.5 text-v2-text-text-base">
        {formatCostPerMillion(props.rate)}
        <span class="text-v2-text-text-faint">{language.t("model.tooltip.cost.perMillion")}</span>
      </span>
    </div>
  )

  const CostRateTable = (props: { rate: ModelCostRate }) => (
    <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
      <div class="border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-[8px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
        {language.t("context.cost.rateCard")}
      </div>
      <CostRateRow label={language.t("context.metric.input")} rate={props.rate.input} />
      <CostRateRow label={language.t("context.metric.output")} rate={props.rate.output} />
      <CostRateRow label={language.t("context.metric.cacheRead")} rate={props.rate.cache.read} />
      <CostRateRow label={language.t("context.metric.cacheWrite")} rate={props.rate.cache.write} />
    </div>
  )

  const ModelUsageRow = (props: { metrics: ModelContextMetrics }) => (
    <AccordionV2.Item value={props.metrics.key}>
      <AccordionV2.Header>
        <AccordionV2.Trigger>
          <div class="flex min-w-0 flex-1 items-center gap-1.5">
            <Tag>{props.metrics.providerLabel}</Tag>
            <Tag variant="accent">{props.metrics.modelLabel}</Tag>
          </div>
          <div class="flex shrink-0 items-center gap-2 text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
            <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5">{formatter().number(props.metrics.total)}</span>
            <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5">{formatter().currency(props.metrics.cost)}</span>
          </div>
        </AccordionV2.Trigger>
      </AccordionV2.Header>
      <AccordionV2.Content>
        <div class="flex w-full flex-col gap-4">
          <div class="grid grid-cols-2 gap-1.5">
            <For each={modelMetricStats(props.metrics, liveDeltaFor(props.metrics))}>
              {(stat) => (
                <MetricCell
                  label={language.t(stat.label as Parameters<typeof language.t>[0])}
                  value={stat.value()}
                  live={stat.live}
                />
              )}
            </For>
            <MetricCell
              label={language.t("context.metric.cacheHit")}
              tooltip={language.t("context.tooltip.cacheHit")}
              value={
                <div class="flex flex-col gap-1">
                  <span>{percentLabel(props.metrics.cacheHitPercent)}</span>
                  <RatioBar percent={props.metrics.cacheHitPercent} color="var(--syntax-success)" />
                </div>
              }
            />
            <MetricCell
              label={language.t("context.metric.tokensPerSecond")}
              tooltip={language.t("context.tooltip.tokensPerSecond")}
              value={tokensPerSecondLabel(props.metrics.tokensPerSecond)}
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">{language.t("context.tokens.title")}</div>
            <CategoryBar segments={buildTokenSegments(props.metrics)} />
          </div>

          <Show when={props.metrics.costBreakdown}>
            <div class="flex flex-col gap-1.5">
              <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">{language.t("context.cost.title")}</div>
              <CategoryBar segments={buildCostSegments(props.metrics.costBreakdown)} />
            </div>
          </Show>

          <Show when={props.metrics.costRate}>{(rate) => <CostRateTable rate={rate()} />}</Show>
        </div>
      </AccordionV2.Content>
    </AccordionV2.Item>
  )

  const ToolCallRow = (props: { part: Extract<Part, { type: "tool" }> }) => {
    const status = () => props.part.state.status
    const duration = createMemo(() => {
      const state = props.part.state
      if (state.status === "completed" || state.status === "error") return (state.time.end - state.time.start) / 1000
      return null
    })
    const color = () =>
      status() === "error"
        ? "var(--syntax-critical)"
        : status() === "completed"
          ? "var(--syntax-success)"
          : "var(--syntax-warning)"
    return (
      <div class="flex items-center justify-between gap-2 border-b border-v2-border-border-muted px-2 py-1 last:border-0">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="size-1.5 shrink-0 rounded-full" style={{ "background-color": color() }} />
          <span class="min-w-0 truncate text-[10px] font-[520] text-v2-text-text-base">{props.part.tool}</span>
        </div>
        <span class="shrink-0 text-[10px] font-[440] tabular-nums text-v2-text-text-faint">
          {duration() !== null ? durationLabel(duration()) : "…"}
        </span>
      </div>
    )
  }

  const RawMessageSummary = (props: { message: Message; parts: Part[] }) => {
    // A single-message call into the exact same aggregator that powers the
    // Session Totals / Per-Model sections above — the per-message numbers
    // are guaranteed consistent with the rest of the pane because they're
    // literally the same math, not a re-derivation of it.
    const metrics = createMemo(() => {
      if (props.message.role !== "assistant") return undefined
      const result = aggregateSessionContextByModel([props.message], { [props.message.id]: props.parts }, providerList())
      return result.models[0]
    })

    const toolCalls = createMemo(() =>
      props.parts.filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool"),
    )

    const bodyText = createMemo(() => {
      const text = props.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n\n")
        .trim()
      return text || undefined
    })

    return (
      <div class="flex flex-col gap-3">
        <Show when={metrics()}>
          {(m) => (
            <>
              <div class="grid grid-cols-2 gap-1.5">
                <MetricCell label={language.t("context.stats.totalTokens")} value={formatter().number(m().total)} />
                <MetricCell label={language.t("context.stats.totalCost")} value={formatter().currency(m().cost)} />
                <MetricCell
                  label={language.t("context.metric.cacheHit")}
                  tooltip={language.t("context.tooltip.cacheHit")}
                  value={percentLabel(m().cacheHitPercent)}
                />
                <MetricCell
                  label={language.t("context.metric.tokensPerSecond")}
                  tooltip={language.t("context.tooltip.tokensPerSecond")}
                  value={tokensPerSecondLabel(m().tokensPerSecond)}
                />
                <MetricCell label={language.t("context.metric.generatedTime")} value={durationLabel(m().generatedSeconds)} />
                <MetricCell label={language.t("context.metric.toolTime")} value={durationLabel(m().toolSeconds)} />
                <MetricCell label={language.t("context.metric.ttft")} value={durationLabel(m().ttftSeconds)} />
                <Show when={m().cacheSavings !== undefined}>
                  <MetricCell
                    label={language.t("context.metric.cacheSavings")}
                    value={formatter().currency(m().cacheSavings)}
                  />
                </Show>
              </div>

              <CategoryBar segments={buildTokenSegments(m())} />

              <Show when={m().costBreakdown}>
                <CategoryBar segments={buildCostSegments(m().costBreakdown)} />
              </Show>
            </>
          )}
        </Show>

        <Show when={bodyText()}>
          {(text) => (
            <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
              <Markdown text={text()} class="text-[11px] leading-4" />
            </div>
          )}
        </Show>

        <Show when={toolCalls().length > 0}>
          <div class="flex flex-col gap-1.5">
            <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
              {language.t("context.rawMessages.toolCalls")}
            </div>
            <InfoCard>
              <For each={toolCalls()}>{(part) => <ToolCallRow part={part} />}</For>
            </InfoCard>
          </div>
        </Show>
      </div>
    )
  }

  const RawMessage = (props: { message: Message }) => {
    const parts = createMemo<Part[]>((previous) => {
      if (!active()) return previous
      return getParts(props.message.id)
    }, [] as Part[])
    const preview = createMemo(() => messagePreviewText(parts()))
    const isOpen = () => rawOpen().includes(props.message.id)

    return (
      <Accordion.Item value={props.message.id}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div class="flex w-full items-center justify-between gap-2 px-1">
              <div class="flex min-w-0 items-center gap-1.5">
                <Tag>{props.message.role}</Tag>
                <Show when={preview()}>
                  <span class="min-w-0 truncate text-[10px] font-[440] italic text-v2-text-text-muted">{preview()}</span>
                </Show>
                <span class="shrink-0 text-[10px] font-[440] text-v2-text-text-faint">{props.message.id}</span>
              </div>
              <div class="flex shrink-0 items-center gap-3">
                <div class="shrink-0 text-[10px] font-[440] tabular-nums text-v2-text-text-faint">
                  {formatter().time(props.message.time.created)}
                </div>
                <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-v2-text-text-faint" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content class="bg-v2-background-bg-layer-01">
          <Show when={isOpen()}>
            <div class="flex flex-col gap-3 p-2">
              <RawMessageSummary message={props.message} parts={parts()} />
              <AccordionV2 collapsible>
                <AccordionV2.Item value="raw">
                  <AccordionV2.Header>
                    <AccordionV2.Trigger>{language.t("context.rawMessages.rawJson")}</AccordionV2.Trigger>
                  </AccordionV2.Header>
                  <AccordionV2.Content>
                    <RawMessageContent message={props.message} getParts={getParts} onRendered={restoreScroll} />
                  </AccordionV2.Content>
                </AccordionV2.Item>
              </AccordionV2>
            </div>
          </Show>
        </Accordion.Content>
      </Accordion.Item>
    )
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-muted px-3 py-1.5">
        <div class="flex min-w-0 items-center gap-2">
          <ProgressCircleV2 percentage={usagePercent() ?? 0} size={16} strokeWidth={2} />
          <span class="shrink-0 text-[10px] font-[560] leading-3 tabular-nums text-v2-text-text-base">
            {formatter().percent(usagePercent())}
          </span>
          <span class="min-w-0 truncate text-[10px] font-[440] leading-3 text-v2-text-text-faint">
            {modelLabel()} · {providerLabel()}
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          <TooltipV2
            value={<div class="max-w-64 text-11-regular">{language.t("command.session.compact.description")}</div>}
            placement="top"
          >
            <button
              type="button"
              data-action="context-compact"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-[520] leading-3 text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={compactDisabled()}
              onClick={() => void compactSession()}
            >
              <Show when={compactBusy()} fallback={<IconV2 name="compact" size="small" />}>
                <LoaderV2 width={14} height={14} />
              </Show>
              <span>{language.t(compactBusy() ? "context.compact.compacting" : "context.compact.action")}</span>
            </button>
          </TooltipV2>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-[520] leading-3 text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
            onClick={exportSession}
          >
            <Icon name="download" size="small" />
            <span>{language.t("context.export.session")}</span>
          </button>
        </div>
      </div>

      <ScrollView
        class="min-h-0 flex-1"
        viewportRef={(el) => {
          scroll = el
          restoreScroll()
        }}
        onScroll={handleScroll}
      >
        <div class="flex flex-col gap-4 p-3 pb-8">
          <div class="grid grid-cols-2 gap-1.5">
            <MetricCell
              label={language.t("context.metric.cacheHit")}
              tooltip={language.t("context.tooltip.cacheHit")}
              value={percentLabel(session().cacheHitPercent)}
            />
            <MetricCell
              label={language.t("context.metric.tokensPerSecond")}
              tooltip={language.t("context.tooltip.tokensPerSecond")}
              value={tokensPerSecondLabel(session().tokensPerSecond)}
            />
            <MetricCell label={language.t("context.stats.totalCost")} value={formatter().currency(session().cost)} />
            <MetricCell label={language.t("context.stats.totalTokens")} value={formatter().number(session().total)} />
          </div>

          <Section title={language.t("context.overview.title")} tooltip={language.t("context.tooltip.overview")}>
            <InfoCard>
              <For each={overviewStats}>
                {(stat) => <InfoRow label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
              </For>
            </InfoCard>
            <div class="flex flex-col gap-1.5 pt-0.5">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                  {language.t("context.stats.usage")}
                </span>
                <span class="text-[10px] font-[520] tabular-nums leading-3 text-v2-text-text-base">
                  {formatter().percent(usagePercent())}
                </span>
              </div>
              <RatioBar percent={usagePercent()} color="var(--syntax-info)" />
            </div>
          </Section>

          <Section title={language.t("context.session.title")} tooltip={language.t("context.tooltip.sessionTotals")}>
            <div class="grid grid-cols-2 gap-1.5">
              <For each={sessionTotalsStats}>
                {(stat) => <MetricCell label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
              </For>
            </div>
            <div class="flex flex-col gap-1.5 pt-0.5">
              <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">{language.t("context.tokens.title")}</div>
              <CategoryBar segments={buildTokenSegments(session())} />
            </div>
          </Section>

          <Section title={language.t("context.timing.title")} tooltip={language.t("context.tooltip.timing")}>
            <div class="grid grid-cols-2 gap-1.5">
              <MetricCell
                label={language.t("context.metric.generatedTime")}
                tooltip={language.t("context.tooltip.generatedTime")}
                value={durationLabel(session().generatedSeconds + liveDelta().generatedSeconds)}
                live={liveDelta().generatedSeconds > 0}
              />
              <MetricCell
                label={language.t("context.metric.toolTime")}
                tooltip={language.t("context.tooltip.toolTime")}
                value={durationLabel(session().toolSeconds + liveDelta().toolSeconds)}
                live={liveDelta().toolSeconds > 0}
              />
              <MetricCell
                label={language.t("context.metric.ttft")}
                tooltip={language.t("context.tooltip.ttft")}
                value={durationLabel(session().ttftSeconds)}
              />
              <MetricCell
                label={language.t("context.metric.upstreamTTFT")}
                tooltip={language.t("context.tooltip.upstreamTTFT")}
                value={durationLabel(session().upstreamTTFTSeconds)}
              />
            </div>
          </Section>

          <Section title={language.t("context.cost.title")} tooltip={language.t("context.tooltip.costBreakdown")}>
            <Show
              when={session().costBreakdown}
              fallback={<div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">{language.t("context.cost.unavailable")}</div>}
            >
              {(breakdown) => (
                <div class="flex flex-col gap-2">
                  <CategoryBar segments={buildCostSegments(breakdown())} />
                  <InfoCard>
                    <InfoRow label={language.t("context.cost.estimatedTotal")} value={formatter().currency(breakdown().total)} />
                    <InfoRow label={language.t("context.cost.billedTotal")} value={formatter().currency(session().cost)} />
                    <Show when={session().cacheSavings !== undefined}>
                      <InfoRow
                        label={
                          <span class="inline-flex items-center gap-1">
                            <span>{language.t("context.metric.cacheSavings")}</span>
                            <TooltipV2 value={<div class="max-w-64 text-11-regular">{language.t("context.tooltip.cacheSavings")}</div>}>
                              <span class="inline-flex text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                                <IconV2 name="help" size="small" />
                              </span>
                            </TooltipV2>
                          </span>
                        }
                        value={formatter().currency(session().cacheSavings)}
                      />
                    </Show>
                  </InfoCard>
                  <Show when={!session().costBreakdownComplete}>
                    <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                      {language.t("context.cost.partial", {
                        available: models().filter((m) => m.costBreakdown).length,
                        total: models().length,
                      })}
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </Section>

          <Section
            title={language.t("context.models.title")}
            tooltip={language.t("context.tooltip.perModel")}
            value={models().length > 0 ? models().length.toLocaleString(language.intl()) : undefined}
          >
            <Show
              when={models().length > 0}
              fallback={<div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">{language.t("context.models.empty")}</div>}
            >
              <AccordionV2 multiple>
                <For each={models()}>{(metrics) => <ModelUsageRow metrics={metrics} />}</For>
              </AccordionV2>
            </Show>
          </Section>

          <DividerV2 />

          <Show when={breakdown().length > 0}>
            <div class="flex flex-col gap-2">
              <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">{language.t("context.breakdown.title")}</div>
              <div class="flex h-2 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03">
                <For each={breakdown()}>
                  {(segment) => (
                    <div
                      class="h-full"
                      style={{
                        width: `${segment.width}%`,
                        "background-color": BREAKDOWN_COLOR[segment.key],
                      }}
                    />
                  )}
                </For>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-1">
                <For each={breakdown()}>
                  {(segment) => (
                    <div class="flex items-center gap-1 text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                      <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                      <div>{breakdownLabel(segment.key)}</div>
                      <div class="text-v2-text-text-faint">{segment.percent.toLocaleString(language.intl())}%</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={systemPrompt()}>
            {(prompt) => (
              <div class="flex flex-col gap-2">
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                  {language.t("context.systemPrompt.title")}
                </div>
                <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
                  <Markdown text={prompt()} class="text-[11px] leading-4" />
                </div>
              </div>
            )}
          </Show>

          <div class="flex flex-col gap-2">
            <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
              {language.t("context.rawMessages.title")}
            </div>
            <Accordion
              multiple
              value={rawOpen()}
              onChange={(value) => setRawOpen(Array.isArray(value) ? value : value ? [value] : [])}
            >
              <For each={messages()}>{(message) => <RawMessage message={message} />}</For>
            </Accordion>
          </div>
        </div>
      </ScrollView>
    </div>
  )
}
