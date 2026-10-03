import { createMemo, createEffect, createSignal, on, onCleanup, For, Show } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { AccordionV2 } from "@opencode-ai/ui/v2/accordion-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { ProgressCircleV2 } from "@opencode-ai/ui/v2/progress-circle-v2"
import type {
  AssistantMessage,
  Message,
  OxpResourceProvenanceInfo,
  Part,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/utils/session-export"
import { sessionTelemetryClientNow, sessionTelemetryElapsedMs } from "@/utils/session-telemetry-time"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { formatCostPerMillion } from "@/components/model-tooltip"
import { formatPercent } from "@/components/usage/usage-format"
import { createUsageValuation } from "@/components/usage/use-usage-valuation"
import { subsidyShare, type SubsidyUsageRow } from "@/utils/usage-subsidy"
import { projectSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import {
  aggregateSessionContextByModel,
  projectSessionContextSnapshot,
  type CostBreakdown,
  type LiveGenerationProgress,
  type ModelContextMetrics,
  type ModelCostRate,
} from "./session-context-model-metrics"
import { createSessionContextFormatter } from "./session-context-format"
import {
  boundedPartsText,
  newestRawMessages,
  RAW_MESSAGE_PAGE_SIZE,
} from "./session-context-raw"
import { MetricCell, Section } from "./insights-primitives"
import { shouldRefreshSessionContext, type SessionContextRefreshState } from "./session-context-refresh"
import {
  newestSessionContextTelemetry,
  normalizeSessionContextResponse,
  projectSessionContextOccupancy,
  type SessionContextTelemetry,
} from "./session-context-occupancy"
import { useQuery } from "@tanstack/solid-query"

const emptyLiveProgress: LiveGenerationProgress = { generatedSeconds: 0, toolSeconds: 0 }
const SESSION_CONTEXT_QUERY_VERSION = 3
type SessionProviderList = NonNullable<Parameters<typeof aggregateSessionContextByModel>[2]>
const emptyProviderList: SessionProviderList = []
const emptyAggregate = aggregateSessionContextByModel()

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  synthetic: "var(--syntax-comment)",
  shell: "var(--syntax-constant)",
  compaction: "var(--syntax-keyword)",
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
  return (
    <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">{props.children}</div>
  )
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
      // Raw tool/message payloads can be multi-megabyte. File cache identity
      // does not justify another O(bytes) hash walk immediately after the
      // unavoidable JSON serialization; use the same bounded sampler as the
      // editor/file-tab path for large content.
      cacheKey: sampledChecksum(contents),
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

function partSummaryText(part: Part): string | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.text.trim() || undefined
  if (part.type === "subtask") return part.description || part.prompt
  if (part.type === "tool") return part.tool
  if (part.type === "file") return part.filename || part.mime
  if (part.type === "step-finish") return part.reason
  if (part.type === "patch") return `${part.files.length} · ${part.hash.slice(0, 12)}`
  if (part.type === "agent") return part.name
  if (part.type === "retry") return `${part.error.name} · ${part.attempt}`
  return undefined
}

const emptyMessages: Message[] = []

type ContextLedgerEntry = {
  messageID: string
  type: string
  role: string
  preview: string
  tokenEstimate: number
  excluded: boolean
  pinned: boolean
  edited: boolean
  hasSignedReasoning: boolean
  partCount: number
  timeCreated: number
}

type ContextLedger = {
  entries: ContextLedgerEntry[]
  totals: {
    messageCount: number
    excludedCount: number
    pinnedCount: number
    editedCount: number
    estimatedTokens: number
    estimatedTokensExcluded: number
  }
}

export function SessionContextTab(props: { active?: Accessor<boolean> }) {
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const platform = usePlatform()
  const local = useLocal()
  const { params, view } = useSessionLayout()
  const active = () => props.active?.() ?? true

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const specialAgentReadOnly = createMemo(() => typeof info()?.metadata?.specialAgent === "string")
  const contextQuery = useQuery(() => ({
    // Version the projection contract explicitly. Solid Query survives renderer
    // HMR, so an older response can otherwise remain resident after the server
    // projection shape/semantics change.
    queryKey: [serverSDK().scope, "usage", "session-context", SESSION_CONTEXT_QUERY_VERSION, params.id] as const,
    enabled: active() && !!params.id,
    staleTime: 2_000,
    gcTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const sessionID = params.id
      if (!sessionID) throw new Error("Missing session")
      const response = await serverSDK().client.usage.sessionContext({ sessionID }, { throwOnError: true })
      return normalizeSessionContextResponse(response.data)
    },
  }))
  const streamedContextTelemetry = createMemo(() =>
    params.id ? serverSync().telemetry.get(params.id) : undefined,
  )
  const contextTelemetry = createMemo(() =>
    newestSessionContextTelemetry(contextQuery.data?.telemetry, streamedContextTelemetry()),
  )
  const snapshotTelemetryReceivedAt = new WeakMap<object, number>()
  const contextTelemetryReceivedAt = (value: SessionContextTelemetry | undefined) => {
    if (!value) return undefined
    const sessionID = params.id
    const streamed = streamedContextTelemetry()
    if (sessionID && value === streamed) return serverSync().telemetry.receivedAt(sessionID)
    const key = value as object
    const existing = snapshotTelemetryReceivedAt.get(key)
    if (existing !== undefined) return existing
    const receivedAt = sessionTelemetryClientNow()
    snapshotTelemetryReceivedAt.set(key, receivedAt)
    return receivedAt
  }
  const contextSnapshot = createMemo(() => {
    if (contextQuery.isPending) return undefined
    const raw = contextQuery.data
    if (!raw) return undefined

    // Solid Query survives renderer HMR and can still hold the previous
    // bare-history payload under this query key. Normalize at consumption as
    // well as fetch time so cached pre-migration data can never reach the pane.
    const snapshot = normalizeSessionContextResponse(raw)
    const telemetry = contextTelemetry()
    if (!telemetry || telemetry === snapshot.telemetry) return snapshot
    return { ...snapshot, telemetry }
  })
  // A zero projection is impossible when the durable Session scalar already
  // records provider usage. Repair that state once per mounted session. This is
  // specifically a cache/version-skew safety net, not a polling path.
  let zeroProjectionRepairFor: string | undefined
  createEffect(() => {
    const sessionID = params.id
    if (!active() || !sessionID || contextQuery.isPending || contextQuery.isFetching) return
    const session = info()
    const snapshot = contextSnapshot()
    if (!session || !snapshot) return

    const durable = session.tokens
    if (!durable) return
    const durableTokens =
      durable.input +
      durable.output +
      durable.reasoning +
      durable.cache.read +
      durable.cache.write
    const tokens = snapshot.history.totals.tokens
    const projectedTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite

    if (durableTokens <= 0 || projectedTokens > 0 || zeroProjectionRepairFor === sessionID) return
    zeroProjectionRepairFor = sessionID
    void contextQuery.refetch()
  })

  const ctx = createMemo(() => projectSessionContextOccupancy(contextSnapshot()))
  const [oxpOrigins, setOxpOrigins] = createSignal<OxpResourceProvenanceInfo[]>([])
  let oxpOriginRequest = 0

  createEffect(
    on(
      () => [active(), params.id] as const,
      ([isActive, sessionID]) => {
        const request = ++oxpOriginRequest
        if (!isActive || !sessionID) {
          setOxpOrigins([])
          return
        }
        const global = serverSDK().client.global
        void Promise.all([
          global.oxpResource(
            { kind: "session", ref: sessionID, limit: "5" },
            { throwOnError: true },
          ),
          global.oxpResource(
            { kind: "worker_session", ref: sessionID, limit: "5" },
            { throwOnError: true },
          ),
        ])
          .then(([session, worker]) => {
            if (request !== oxpOriginRequest) return
            const rows = [...(session.data ?? []), ...(worker.data ?? [])]
            const unique = new Map(
              rows.map((row) => [
                row.activityID + ":" + row.invocationID,
                row,
              ]),
            )
            setOxpOrigins(
              [...unique.values()]
                .sort(
                  (left, right) =>
                    Number(right.startedAt) - Number(left.startedAt),
                )
                .slice(0, 5),
            )
          })
          .catch(() => {
            if (request === oxpOriginRequest) setOxpOrigins([])
          })
      },
    ),
  )

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
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  // Raw-message expansion still uses the existing single-message
  // presentation aggregator, but its provider metadata comes from the compact
  // server projection rather than hydrating workspace provider state.
  const providerList = createMemo<SessionProviderList>(() => {
    const snapshot = contextSnapshot()
    if (!snapshot) return emptyProviderList
    const byProvider = new Map<string, SessionProviderList[number]>()
    for (const model of snapshot.history.models) {
      const provider =
        byProvider.get(model.providerID) ??
        ({
          id: model.providerID,
          name: model.providerName,
          models: {},
        } satisfies SessionProviderList[number])
      provider.models[model.modelID] = {
        name: model.modelName,
        limit: { context: 0 },
        cost: model.costRate,
      }
      byProvider.set(model.providerID, provider)
    }
    return [...byProvider.values()]
  })
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const [rawOpen, setRawOpen] = createSignal<string[]>([])
  const [rawLimit, setRawLimit] = createSignal(RAW_MESSAGE_PAGE_SIZE)
  const rawMessages = createMemo(() => newestRawMessages(messages(), rawLimit()))
  const hiddenRawCount = createMemo(() => Math.max(0, messages().length - rawMessages().length))

  // Reset accordion open state + gate live timer on session/tab switch (prevents
  // stale teardown and effect churn for inactive tabs after keep-mounted shell).
  createEffect(
    on(
      () => params.id,
      (current, previous) => {
        if (current !== previous) {
          setRawOpen([])
          setRawLimit(RAW_MESSAGE_PAGE_SIZE)
        }
      },
    ),
  )

  // Raw transcript state is used here only for compaction-control UX.
  // Authoritative live timing below is driven exclusively by SessionTelemetry,
  // so transcript virtualization cannot alter any displayed usage metric.
  const liveMessage = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role !== "assistant") continue
      return msg.time.completed ? undefined : (msg as AssistantMessage)
    }
    return undefined
  })
  const liveTelemetryTickKey = createMemo(() => {
    const telemetry = contextTelemetry()
    if (!telemetry || telemetry.phase === "idle") return undefined
    return `${telemetry.step?.assistantMessageID ?? ""}:${telemetry.phase}`
  })
  createEffect(() => {
    if (!active() || !params.id) return
    serverSync().telemetry.ensure([params.id])
  })

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

  const compactDisabled = () => !params.id || specialAgentReadOnly() || counts().user === 0 || compactBusy()

  const [now, setNow] = createSignal(Date.now())
  createEffect(
    on(
      () => [active(), liveTelemetryTickKey()] as const,
      ([isActive, key]) => {
        if (!isActive || !key) return
        setNow(Date.now())
        const interval = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(interval))
      },
    ),
  )

  const liveDelta = createMemo<LiveGenerationProgress>(() => {
    const telemetry = contextTelemetry()
    if (!params.id || !telemetry?.step || telemetry.phase === "idle") return emptyLiveProgress
    // Keep the existing 1s reactive tick, but measure the open phase across
    // producer/client clock domains explicitly.
    now()
    const openMs = sessionTelemetryElapsedMs({
      startedAt: telemetry.phaseStartedAt,
      sampledAt: telemetry.sampledAt,
      updatedAt: telemetry.updatedAt,
      receivedAt: contextTelemetryReceivedAt(telemetry),
      now: sessionTelemetryClientNow(),
    })
    return {
      generatedSeconds:
        (telemetry.step.generatedMs +
          (telemetry.phase === "generating" || telemetry.phase === "reasoning" ? openMs : 0)) /
        1000,
      toolSeconds: (telemetry.step.toolMs + (telemetry.phase === "tool" ? openMs : 0)) / 1000,
    }
  })

  const liveDeltaFor = (metrics: ModelContextMetrics): LiveGenerationProgress => {
    const model = contextTelemetry()?.model
    if (!model || `${model.providerID}:${model.modelID}` !== metrics.key) return emptyLiveProgress
    return liveDelta()
  }

  const counts = createMemo(
    () => contextSnapshot()?.history.counts ?? { all: 0, user: 0, assistant: 0 },
  )

  const systemPrompt = createMemo(() => {
    const prompt = contextSnapshot()?.history.systemPrompt
    if (!prompt) return undefined
    const trimmed = prompt.trim()
    return trimmed || undefined
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

  const breakdown = createMemo(() => {
    const snapshot = contextSnapshot()
    const total = ctx()?.total
    if (!snapshot || !total) return []
    return projectSessionContextBreakdown(snapshot.history.breakdown, total)
  })

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "synthetic") return language.t("context.breakdown.synthetic", { defaultValue: "Automation" })
    if (key === "shell") return language.t("context.breakdown.shell", { defaultValue: "Shell" })
    if (key === "compaction") return language.t("context.breakdown.compaction", { defaultValue: "Compaction" })
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
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.updatedAt ?? contextSnapshot()?.history.updatedAt ?? info()?.time.updated) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const usagePercent = createMemo(() => ctx()?.usage ?? null)

  const aggregate = createMemo(() => {
    const snapshot = contextSnapshot()
    return snapshot ? projectSessionContextSnapshot(snapshot) : emptyAggregate
  })

  const session = createMemo(() => aggregate().session)
  const models = createMemo(() => aggregate().models)

  // Preserve the exact free-token bundle accumulated per turn, then add a
  // paid companion row solely so the shared valuation can compute free share
  // against actual spend. This is more precise than the Usage page's
  // aggregate fallback, where mixed rows must sometimes be pro-rated.
  const valuationRows = createMemo<SubsidyUsageRow[]>(() =>
    models().flatMap((metrics) => {
      const paidMessages = metrics.messageCount - metrics.freeMessageCount
      const paidTokens = {
        input: metrics.input - metrics.freeTokens.input,
        output: metrics.output - metrics.freeTokens.output,
        reasoning: metrics.reasoning - metrics.freeTokens.reasoning,
        cacheRead: metrics.cacheRead - metrics.freeTokens.cacheRead,
        cacheWrite: metrics.cacheWrite - metrics.freeTokens.cacheWrite,
      }
      return [
        ...(metrics.freeMessageCount > 0
          ? [
              {
                providerID: metrics.providerID,
                modelID: metrics.modelID,
                variant: null,
                messages: metrics.freeMessageCount,
                cost: 0,
                estimatedCost: 0,
                unpricedRecords: metrics.freeMessageCount,
                tokens: metrics.freeTokens,
              },
            ]
          : []),
        ...(paidMessages > 0
          ? [
              {
                providerID: metrics.providerID,
                modelID: metrics.modelID,
                variant: null,
                messages: paidMessages,
                cost: metrics.cost,
                estimatedCost: 0,
                unpricedRecords: 0,
                tokens: paidTokens,
              },
            ]
          : []),
      ]
    }),
  )
  // Usage valuation is process-global and bootstrap-free. Keep rate-card
  // inference on the same owner as the session projection instead of hydrating
  // workspace provider state solely for this pane.
  const valuation = createUsageValuation(valuationRows, () => [], { enabled: active })
  const subsidy = () => valuation.subsidy()
  const subsidyByModel = createMemo(
    () => new Map(subsidy().rows.map((row) => [`${row.providerID}:${row.modelID}`, row])),
  )
  const subsidyValue = () =>
    valuation.catalogReady() ? formatter().currency(subsidy().total) : language.t("context.metric.unavailable")
  const subsidyShareValue = () =>
    valuation.catalogReady()
      ? formatPercent(subsidyShare(subsidy()), language.intl())
      : language.t("context.metric.unavailable")

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
      {
        label: "context.stats.messages",
        value: () => metrics.messageCount.toLocaleString(language.intl()),
        live: false,
      },
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
        ? [
            {
              label: "context.metric.cacheSavings",
              value: () => formatter().currency(metrics.cacheSavings),
              live: false,
            },
          ]
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
  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement>()
  const [ledgerElement, setLedgerElement] = createSignal<HTMLElement>()
  const [ledgerVisible, setLedgerVisible] = createSignal(false)
  const [ledger, setLedger] = createSignal<ContextLedger | null>(null)
  const [ledgerBusy, setLedgerBusy] = createSignal<string | null>(null)
  const [ledgerError, setLedgerError] = createSignal<string | null>(null)

  const fetchLedger = async (sessionID = params.id) => {
    if (!sessionID) return
    try {
      const res = await (
        sdk().client as unknown as {
          sessionContext: { ledger: (p: Record<string, unknown>) => Promise<{ data: unknown }> }
        }
      ).sessionContext.ledger({ sessionID })
      const data = (res as unknown as { data?: unknown }).data ?? res
      if (params.id === sessionID) {
        setLedger(data as ContextLedger)
        setLedgerError(null)
      }
    } catch (e) {
      if (params.id === sessionID) setLedgerError(e instanceof Error ? e.message : String(e))
    }
  }

  createEffect(
    on(
      () => [active(), params.id] as const,
      ([isActive, sessionID]) => {
        setLedger(null)
        setLedgerError(null)
        setLedgerVisible(false)
        if (!isActive || !sessionID) return
      },
    ),
  )

  // The actionable ledger is intentionally O(messages), unlike the fixed-size
  // analytics projection above. Prefetch it only when the user approaches the
  // ledger section so opening the Context pane never hydrates the full
  // transcript just to render summary metrics.
  createEffect(
    on(
      () => [active(), params.id, scrollElement(), ledgerElement()] as const,
      ([isActive, sessionID, root, target]) => {
        if (!isActive || !sessionID || !root || !target) return
        if (typeof IntersectionObserver === "undefined") {
          setLedgerVisible(true)
          return
        }
        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return
            setLedgerVisible(true)
            observer.disconnect()
          },
          { root, rootMargin: "600px 0px" },
        )
        observer.observe(target)
        onCleanup(() => observer.disconnect())
      },
    ),
  )

  createEffect(
    on(
      () => [active(), params.id, ledgerVisible()] as const,
      ([isActive, sessionID, visible]) => {
        if (!isActive || !sessionID || !visible || ledger()) return
        void fetchLedger(sessionID)
      },
    ),
  )
  // Provider-step completion is intentionally NOT the durable-history
  // watermark: telemetry settles at the step boundary, while UsageRecord is
  // committed later during processor cleanup. SessionStatus publishes the
  // shared telemetry idle watermark only after that cleanup has drained, so
  // refresh when the same session's idle updatedAt advances instead of racing
  // storage behind an arbitrary timeout. This also catches turns shorter than
  // the telemetry coalescing window (idle -> idle with a newer watermark).
  // Do not use the endpoint's own idle snapshot here: its arrival on first open
  // would otherwise trigger an immediate duplicate query.
  // Reactivating the pane remains the catch-up path for mutations that landed
  // while this keep-mounted panel was inactive.
  createEffect(
    on(
      () => {
        const telemetry = params.id ? serverSync().telemetry.get(params.id) : undefined
        return [active(), params.id, telemetry?.phase, telemetry?.updatedAt] as SessionContextRefreshState
      },
      (next, previous) => {
        if (!shouldRefreshSessionContext(next, previous)) return
        const sessionID = next[1]
        if (!sessionID) return
        if (!contextQuery.isFetching) void contextQuery.refetch()
        if (ledgerVisible() || ledger()) void fetchLedger(sessionID)
      },
      { defer: true },
    ),
  )

  const applyLedgerOperation = async (op: Record<string, unknown>) => {
    const sessionID = params.id
    if (!sessionID || specialAgentReadOnly()) return
    const key = `${op.type}:${op.messageID}`
    setLedgerBusy(key)
    try {
      await (
        sdk().client as unknown as {
          sessionContext: { applyOps: (p: Record<string, unknown>) => Promise<unknown> }
        }
      ).sessionContext.applyOps({ sessionID, operations: [op] })
      // Context operations mutate the prospective effective ledger only.
      // Historical usage and provider-reported occupancy do not change until a
      // later generation settles, so do not force an O(history) projection scan.
      await fetchLedger(sessionID)
      showToast({ variant: "success", title: language.t("context.ledger.applied") })
    } catch (e) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setLedgerBusy(null)
    }
  }

  const ledgerUsagePercent = createMemo(() => {
    const limit = ctx()?.limit
    const tokens = ledger()?.totals.estimatedTokens
    if (!limit || tokens === undefined) return null
    return (tokens / limit) * 100
  })
  const ledgerByMessage = createMemo(
    () => new Map((ledger()?.entries ?? []).map((entry) => [entry.messageID, entry] as const)),
  )

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

  const ModelUsageRow = (props: { metrics: ModelContextMetrics }) => {
    const free = createMemo(() => subsidyByModel().get(props.metrics.key))
    return (
      <AccordionV2.Item value={props.metrics.key}>
        <AccordionV2.Header>
          <AccordionV2.Trigger>
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <Tag>{props.metrics.providerLabel}</Tag>
              <Tag variant="accent">{props.metrics.modelLabel}</Tag>
            </div>
            <div class="flex shrink-0 items-center gap-2 text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
              <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5">
                {formatter().number(props.metrics.total)}
              </span>
              <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5">
                {formatter().currency(props.metrics.cost)}
              </span>
              <Show when={free()?.value}>
                {(value) => (
                  <span
                    class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-v2-text-text-accent"
                    title={language.t("context.tooltip.freeValue")}
                  >
                    +{formatter().currency(value())}
                  </span>
                )}
              </Show>
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
              <Show when={free()}>
                {(row) => (
                  <MetricCell
                    label={language.t("context.metric.freeValue")}
                    tooltip={language.t("context.tooltip.freeValue")}
                    value={formatter().currency(row().value)}
                    sub={language.plural("usage.turns", row().freeMessages)}
                    accent
                  />
                )}
              </Show>
            </div>

            <div class="flex flex-col gap-1.5">
              <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                {language.t("context.tokens.title")}
              </div>
              <CategoryBar segments={buildTokenSegments(props.metrics)} />
            </div>

            <Show when={props.metrics.costBreakdown}>
              <div class="flex flex-col gap-1.5">
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                  {language.t("context.cost.title")}
                </div>
                <CategoryBar segments={buildCostSegments(props.metrics.costBreakdown)} />
              </div>
            </Show>

            <Show when={props.metrics.costRate}>{(rate) => <CostRateTable rate={rate()} />}</Show>
          </div>
        </AccordionV2.Content>
      </AccordionV2.Item>
    )
  }

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
    // Raw inspection is deliberately presentation-local. The authoritative
    // Session Totals / Per-Model sections above come from the server projection;
    // this single-message aggregator exists only to annotate the optional raw
    // message viewer without reconstructing whole-history metrics client-side.
    const metrics = createMemo(() => {
      if (props.message.role !== "assistant") return undefined
      const result = aggregateSessionContextByModel(
        [props.message],
        { [props.message.id]: props.parts },
        providerList(),
      )
      return result.models[0]
    })

    const toolCalls = createMemo(() =>
      props.parts.filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool"),
    )

    const bodyText = createMemo(() =>
      boundedPartsText(props.parts, (part) =>
        part.type === "text" && !part.synthetic && !part.ignored ? part.text : undefined,
      ),
    )

    const reasoningText = createMemo(() =>
      boundedPartsText(props.parts, (part) => (part.type === "reasoning" ? part.text : undefined)),
    )

    const partFallback = createMemo(() => {
      if (bodyText() || reasoningText() || toolCalls().length > 0) return []
      return props.parts
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
                <MetricCell
                  label={language.t("context.metric.generatedTime")}
                  value={durationLabel(m().generatedSeconds)}
                />
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

        <Show when={!bodyText() && reasoningText()}>
          {(text) => (
            <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
              <div class="mb-1 text-[9px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
                {language.t("context.rawMessages.reasoning")}
              </div>
              <Markdown text={text()} class="text-[11px] leading-4 text-v2-text-text-muted" />
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

        <Show when={partFallback().length > 0}>
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2 text-[10px] font-[440] leading-3 text-v2-text-text-muted">
              <span>{language.t("context.rawMessages.partSummary")}</span>
              <span class="tabular-nums text-v2-text-text-faint">{partFallback().length}</span>
            </div>
            <InfoCard>
              <For each={partFallback()}>
                {(part) => (
                  <div class="flex min-w-0 items-center gap-1.5 border-b border-v2-border-border-muted px-2 py-1 last:border-0">
                    <Tag>{part.type}</Tag>
                    <span class="min-w-0 truncate text-[10px] text-v2-text-text-muted">
                      {partSummaryText(part) ?? language.t("context.rawMessages.structuredPart")}
                    </span>
                  </div>
                )}
              </For>
            </InfoCard>
          </div>
        </Show>

        <Show when={!bodyText() && !reasoningText() && toolCalls().length === 0 && props.parts.length === 0}>
          <div class="rounded-md border border-dashed border-v2-border-border-muted px-2.5 py-2 text-[10px] leading-3 text-v2-text-text-faint">
            {language.t("context.rawMessages.noContent")}
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
    const entry = createMemo(() => ledgerByMessage().get(props.message.id))
    const isOpen = () => rawOpen().includes(props.message.id)

    return (
      <Accordion.Item value={props.message.id}>
        <StickyAccordionHeader class="group relative">
          <Accordion.Trigger class="!h-11 !items-start !py-1.5 !pr-32">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 px-1">
              <div class="flex min-w-0 items-center gap-1.5">
                <span
                  class="size-1.5 shrink-0 rounded-full bg-v2-text-text-faint"
                  classList={{
                    "bg-v2-state-fg-warning": !!entry()?.pinned && !entry()?.excluded,
                    "bg-v2-state-fg-danger": !!entry()?.excluded,
                  }}
                />
                <Tag>{props.message.role}</Tag>
                <Show when={preview()}>
                  <span
                    class="min-w-0 truncate text-[10px] font-[440] italic text-v2-text-text-muted"
                    classList={{ "line-through opacity-60": entry()?.excluded }}
                  >
                    {preview()}
                  </span>
                </Show>
              </div>
              <div class="flex min-w-0 items-center gap-1.5 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
                <span class="min-w-0 truncate font-mono">{props.message.id}</span>
                <span class="text-v2-text-text-faint/60">·</span>
                <Show when={entry()}>
                  {(item) => <span class="shrink-0 tabular-nums">{formatter().number(item().tokenEstimate)} tok</span>}
                </Show>
                <span class="text-v2-text-text-faint/60">·</span>
                <span class="shrink-0 tabular-nums">{formatter().time(props.message.time.created)}</span>
                <Show when={entry()?.edited}>
                  <span class="rounded bg-v2-state-bg-info px-1 py-0.5 text-[8px] font-[600] uppercase leading-none text-v2-state-fg-info">
                    {language.t("context.ledger.edited")}
                  </span>
                </Show>
                <Show when={entry()?.excluded}>
                  <span class="rounded bg-v2-state-bg-danger px-1 py-0.5 text-[8px] font-[600] uppercase leading-none text-v2-state-fg-danger">
                    {language.t("context.ledger.excluded")}
                  </span>
                </Show>
                <Show when={entry()?.pinned}>
                  <span class="rounded bg-v2-state-bg-warning px-1 py-0.5 text-[8px] font-[600] uppercase leading-none text-v2-state-fg-warning">
                    {language.t("context.ledger.pinned")}
                  </span>
                </Show>
                <Show when={entry()?.hasSignedReasoning}>
                  <TooltipV2 value={language.t("context.ledger.locked.tooltip")}>
                    <span class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[8px]" tabIndex={0}>
                      {language.t("context.ledger.locked")}
                    </span>
                  </TooltipV2>
                </Show>
              </div>
            </div>
          </Accordion.Trigger>
          <Show when={!specialAgentReadOnly() ? entry() : undefined}>
            {(item) => (
              <div class="absolute right-1 top-1/2 z-[1] flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-v2-background-bg-base/95 pl-1 shadow-[-8px_0_12px_-8px_var(--v2-background-bg-base)]">
                <Show
                  when={!item().excluded}
                  fallback={
                    <ButtonV2
                      variant="ghost-muted"
                      size="small"
                      class="!h-5 !px-1.5 !text-[10px] !leading-3"
                      disabled={ledgerBusy() === `message.include:${item().messageID}`}
                      onClick={() =>
                        void applyLedgerOperation({ type: "message.include", messageID: item().messageID })
                      }
                    >
                      {language.t("context.ledger.restore")}
                    </ButtonV2>
                  }
                >
                  <ButtonV2
                    variant="ghost-muted"
                    size="small"
                    class="!h-5 !px-1.5 !text-[10px] !leading-3"
                    disabled={item().hasSignedReasoning || ledgerBusy() === `message.exclude:${item().messageID}`}
                    title={
                      item().hasSignedReasoning
                        ? language.t("context.ledger.locked.tooltip")
                        : language.t("context.ledger.remove.tooltip")
                    }
                    onClick={() => void applyLedgerOperation({ type: "message.exclude", messageID: item().messageID })}
                  >
                    {language.t("context.ledger.remove")}
                  </ButtonV2>
                </Show>
                <ButtonV2
                  variant={item().pinned ? "warning" : "ghost-muted"}
                  size="small"
                  class="!h-5 !w-5 !min-w-5 !px-0"
                  icon={item().pinned ? "pin-filled" : "pin"}
                  disabled={ledgerBusy() === `message.${item().pinned ? "unpin" : "pin"}:${item().messageID}`}
                  title={language.t(item().pinned ? "context.ledger.unpin" : "context.ledger.pin")}
                  aria-label={language.t(item().pinned ? "context.ledger.unpin" : "context.ledger.pin")}
                  onClick={() =>
                    void applyLedgerOperation({
                      type: item().pinned ? "message.unpin" : "message.pin",
                      messageID: item().messageID,
                    })
                  }
                />
                <Icon name="chevron-grabber-vertical" size="small" class="mx-0.5 shrink-0 text-v2-text-text-faint" />
              </div>
            )}
          </Show>
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
          setScrollElement(el)
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
            <MetricCell
              label={language.t("context.metric.freeValue")}
              tooltip={language.t("context.tooltip.freeValue")}
              value={subsidyValue()}
              sub={language.plural("usage.turns", subsidy().freeMessages)}
              accent={valuation.catalogReady() && subsidy().total > 0}
            />
            <MetricCell
              label={language.t("context.metric.freeShare")}
              tooltip={language.t("context.tooltip.freeShare")}
              value={subsidyShareValue()}
            />
          </div>

          <Show when={oxpOrigins().length > 0}>
            <Section title="Origin">
              <InfoCard>
                <For each={oxpOrigins()}>
                  {(origin) => (
                    <InfoRow
                      label={
                        <span class="inline-flex items-center gap-1">
                          <span>ChatGPT / OXP</span>
                          <span class="text-v2-text-text-faint">
                            {origin.relation}
                          </span>
                        </span>
                      }
                      value={
                        <button
                          type="button"
                          class="max-w-[180px] truncate text-v2-text-text-accent hover:underline"
                          title={origin.activityID}
                          onClick={() =>
                            navigate(`/oxp/activity/${origin.activityID}`)
                          }
                        >
                          Open OXP activity
                        </button>
                      }
                    />
                  )}
                </For>
              </InfoCard>
            </Section>
          </Show>

          <Section title={language.t("context.overview.title")} tooltip={language.t("context.tooltip.overview")}>
            <InfoCard>
              <For each={overviewStats}>
                {(stat) => (
                  <InfoRow label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />
                )}
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
                {(stat) => (
                  <MetricCell label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />
                )}
              </For>
            </div>
            <div class="flex flex-col gap-1.5 pt-0.5">
              <div class="text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                {language.t("context.tokens.title")}
              </div>
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
            <div class="flex flex-col gap-2">
              <Show
                when={session().costBreakdown}
                fallback={
                  <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                    {language.t("context.cost.unavailable")}
                  </div>
                }
              >
                {(breakdown) => <CategoryBar segments={buildCostSegments(breakdown())} />}
              </Show>
              <InfoCard>
                <Show when={session().costBreakdown}>
                  {(breakdown) => (
                    <InfoRow
                      label={language.t("context.cost.estimatedTotal")}
                      value={formatter().currency(breakdown().total)}
                    />
                  )}
                </Show>
                <InfoRow label={language.t("context.cost.billedTotal")} value={formatter().currency(session().cost)} />
                <InfoRow
                  label={language.t("context.cost.freeValue")}
                  value={
                    <span classList={{ "text-v2-text-text-accent": valuation.catalogReady() && subsidy().total > 0 }}>
                      {subsidyValue()}
                    </span>
                  }
                />
                <Show when={session().cacheSavings !== undefined}>
                  <InfoRow
                    label={
                      <span class="inline-flex items-center gap-1">
                        <span>{language.t("context.metric.cacheSavings")}</span>
                        <TooltipV2
                          value={
                            <div class="max-w-64 text-11-regular">{language.t("context.tooltip.cacheSavings")}</div>
                          }
                        >
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
              <Show when={!valuation.catalogReady()}>
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                  {language.t("usage.valuation.noCatalog")}
                </div>
              </Show>
              <Show when={valuation.catalogReady() && subsidy().unvalued.models > 0}>
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                  {language.t("usage.subsidy.footnoteUnvalued", {
                    models: subsidy().unvalued.models.toLocaleString(language.intl()),
                    tokens: formatter().number(subsidy().unvalued.tokens),
                  })}
                </div>
              </Show>
              <Show when={!session().costBreakdownComplete}>
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                  {language.t("context.cost.partial", {
                    available: models().filter((m) => m.costBreakdown).length,
                    total: models().length,
                  })}
                </div>
              </Show>
            </div>
          </Section>

          <Section
            title={language.t("context.models.title")}
            tooltip={language.t("context.tooltip.perModel")}
            value={models().length > 0 ? models().length.toLocaleString(language.intl()) : undefined}
          >
            <Show
              when={models().length > 0}
              fallback={
                <div class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                  {language.t("context.models.empty")}
                </div>
              }
            >
              <AccordionV2 multiple>
                <For each={models()}>{(metrics) => <ModelUsageRow metrics={metrics} />}</For>
              </AccordionV2>
            </Show>
          </Section>

          <DividerV2 />

          <Show when={breakdown().length > 0}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-1 text-[10px] font-[440] leading-3 text-v2-text-text-muted">
                  <span>{language.t("context.breakdown.title")}</span>
                  <TooltipV2 value={<div class="max-w-72 text-11-regular">{language.t("context.breakdown.note")}</div>}>
                    <span class="inline-flex text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                      <IconV2 name="help" size="small" />
                    </span>
                  </TooltipV2>
                </div>
                <span class="shrink-0 text-[10px] font-[520] tabular-nums leading-3 text-v2-text-text-faint">
                  {formatter().number(ctx()?.total)} {language.t("context.ledger.tokens")}
                </span>
              </div>
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

          <section ref={setLedgerElement} class="flex flex-col gap-2">
            <div class="flex items-baseline justify-between gap-2">
              <div class="min-w-0">
                <h3 class="flex items-center gap-1 text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
                  {language.t("context.ledger.title")}
                  <TooltipV2 value={<div class="max-w-64 text-11-regular">{language.t("context.ledger.tooltip")}</div>}>
                    <span class="inline-flex text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                      <IconV2 name="help" size="small" />
                    </span>
                  </TooltipV2>
                </h3>
                <p class="mt-1 text-[10px] leading-3 text-v2-text-text-faint">
                  {language.t("context.ledger.description")}
                </p>
              </div>
              <span class="shrink-0 text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
                {counts().all.toLocaleString(language.intl())}
              </span>
            </div>

            <div class="overflow-hidden rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-sunken)]">
              <Show
                when={ledger()}
                fallback={
                  <div class="border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2 text-[10px] leading-3 text-v2-text-text-faint">
                    {language.t(ledgerError() ? "context.ledger.error" : "context.ledger.loading")}
                  </div>
                }
              >
                {(l) => (
                  <div class="flex flex-col gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex min-w-0 items-center gap-1.5">
                        <ProgressCircleV2 percentage={ledgerUsagePercent() ?? 0} size={16} strokeWidth={2} />
                        <span class="text-[10px] font-[560] leading-3 text-v2-text-text-base">
                          {language.t("context.ledger.effective")}
                        </span>
                      </div>
                      <span class="shrink-0 text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
                        {formatter().number(l().totals.estimatedTokens)} {language.t("context.ledger.tokens")}
                      </span>
                    </div>
                    <RatioBar percent={ledgerUsagePercent()} color="var(--syntax-info)" />
                    <div class="grid grid-cols-3 gap-1.5">
                      <MetricCell label={language.t("context.ledger.messages")} value={`${l().totals.messageCount}`} />
                      <MetricCell
                        label={language.t("context.ledger.included")}
                        value={`${l().totals.messageCount - l().totals.excludedCount}`}
                      />
                      <MetricCell
                        label={language.t("context.ledger.excluded")}
                        value={`${l().totals.excludedCount}`}
                        tooltip={language.t("context.ledger.excluded.tooltip")}
                      />
                    </div>
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-3 text-v2-text-text-faint">
                      <span>
                        {language.t("context.ledger.occupancy", {
                          tokens: formatter().number(l().totals.estimatedTokens),
                        })}
                      </span>
                      <Show when={l().totals.pinnedCount > 0}>
                        <span class="text-v2-text-text-faint/60">·</span>
                        <span>{language.t("context.ledger.pinnedCount", { count: l().totals.pinnedCount })}</span>
                      </Show>
                      <Show when={l().totals.editedCount > 0}>
                        <span class="text-v2-text-text-faint/60">·</span>
                        <span>{language.t("context.ledger.editedCount", { count: l().totals.editedCount })}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>

              <div class="flex items-center justify-between gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-base px-2.5 py-1.5">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="text-[10px] font-[560] leading-3 text-v2-text-text-base">
                    {language.t("context.ledger.messages")}
                  </span>
                  <span class="text-[9px] leading-3 text-v2-text-text-faint">
                    {language.t("context.ledger.inspectHint")}
                  </span>
                </div>
                <Show when={messages().length > 0}>
                  <div class="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      class="rounded px-1.5 py-1 text-[9px] font-[520] leading-3 text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                      onClick={() => setRawOpen(rawMessages().map((message) => message.id))}
                    >
                      {language.t("context.ledger.expandAll")}
                    </button>
                    <button
                      type="button"
                      class="rounded px-1.5 py-1 text-[9px] font-[520] leading-3 text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                      onClick={() => setRawOpen([])}
                    >
                      {language.t("context.ledger.collapseAll")}
                    </button>
                  </div>
                </Show>
              </div>

              <Show
                when={messages().length > 0}
                fallback={
                  <div class="px-2.5 py-3 text-[10px] leading-3 text-v2-text-text-faint">
                    {language.t("context.ledger.empty")}
                  </div>
                }
              >
                <Show when={hiddenRawCount() > 0}>
                  <button
                    type="button"
                    class="flex w-full items-center justify-center border-b border-v2-border-border-muted px-2.5 py-1.5 text-[9px] font-[520] leading-3 text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => setRawLimit((value) => value + RAW_MESSAGE_PAGE_SIZE)}
                  >
                    {language.t("common.loadMore")} ({Math.min(RAW_MESSAGE_PAGE_SIZE, hiddenRawCount())})
                  </button>
                </Show>
                <Accordion
                  multiple
                  value={rawOpen()}
                  onChange={(value) => setRawOpen(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={rawMessages()}>{(message) => <RawMessage message={message} />}</For>
                </Accordion>
              </Show>

              <Show when={ledger()?.totals.excludedCount || ledger()?.totals.editedCount}>
                <div class="border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-1.5 text-[9px] leading-3 text-v2-text-text-faint">
                  {language.t("context.ledger.spendNote")}
                </div>
              </Show>
            </div>
          </section>
        </div>
      </ScrollView>
    </div>
  )
}
