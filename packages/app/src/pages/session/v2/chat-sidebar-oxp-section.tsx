import type { OxpAttributionSnapshot, OxpParentActivitySummary } from "@opencode-ai/sdk/v2/client"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createEffect, createMemo, createSignal, For, lazy, onMount, Show, Suspense, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOxpActivity } from "@/context/oxp-activity"
import { useServerSDK } from "@/context/server-sdk"
import {
  ATTRIBUTION_WINDOW_MS,
  OXP_PAGE_INITIAL,
  OXP_PAGE_STEP,
  compact,
  finite,
  isLive,
  newestSeenAt,
  planeMix,
  relativeStampParts,
  shouldRefreshAttribution,
  sumPlaneMix,
  type PlaneMix,
} from "./chat-sidebar-oxp-model"
import "./chat-sidebar-oxp-section.css"

const OxpActivityContextMenu = lazy(() =>
  import("@/components/oxp-activity-context-menu").then((module) => ({ default: module.OxpActivityContextMenu })),
)

type AttributionState = {
  status: "idle" | "loading" | "ready" | "error"
  snapshot?: OxpAttributionSnapshot
}

function PlaneBar(props: { mix: PlaneMix; slot: "plane-mix" | "row-mix"; tooltip?: string }) {
  return (
    <span
      data-slot={props.slot}
      data-empty={props.mix.total === 0 ? "true" : undefined}
      data-chat-tooltip-text={props.tooltip}
      data-chat-tooltip-placement={props.tooltip ? "top" : undefined}
      aria-hidden="true"
    >
      <span data-plane="augmentation" style={{ "flex-grow": props.mix.augmentationShare }} />
      <span data-plane="supervision" style={{ "flex-grow": props.mix.supervisionShare }} />
      <span data-plane="delegation" style={{ "flex-grow": props.mix.delegationShare }} />
    </span>
  )
}

export function ChatSidebarOxpSection(props: {
  collapsed: boolean
  onToggle: () => void
  selectedActivityID?: string
  minuteNow: () => number
  onOpen: (activityID: string) => void
}): JSX.Element {
  const language = useLanguage()
  const oxpActivity = useOxpActivity()
  const serverSDK = useServerSDK()

  const [state, setState] = createStore({ limit: OXP_PAGE_INITIAL })
  const [contextMenu, setContextMenu] = createSignal<{ activityID: string; x: number; y: number }>()
  const [attribution, setAttribution] = createStore<AttributionState>({ status: "idle" })

  const activities = () => oxpActivity.activities()
  const visible = createMemo(() => activities().slice(0, state.limit))
  const newest = createMemo(() => newestSeenAt(activities()))
  const totalMix = createMemo(() => sumPlaneMix(activities()))

  onMount(() => oxpActivity.ensureLoaded())

  // 24h attribution: one lazy request, gated on expansion + 60s throttle. No timers.
  let lastFetchAt: number | undefined
  let lastFetchedNewest: number | undefined
  let inflight = false
  let wasCollapsed = false
  let generation = 0

  const fetchAttribution = (now: number, seenAt: number) => {
    inflight = true
    lastFetchAt = now
    lastFetchedNewest = seenAt
    const mine = ++generation
    if (!attribution.snapshot) setAttribution("status", "loading")
    void serverSDK()
      .client.global.oxpAttribution({ since: String(now - ATTRIBUTION_WINDOW_MS), until: String(now) }, { throwOnError: true })
      .then((result) => {
        if (mine !== generation) return
        setAttribution({ status: "ready", snapshot: result.data })
      })
      .catch(() => {
        if (mine !== generation) return
        setAttribution("status", attribution.snapshot ? "ready" : "error")
      })
      .finally(() => {
        if (mine === generation) inflight = false
      })
  }

  createEffect(() => {
    const collapsed = props.collapsed
    const hasActivity = activities().length > 0
    const seenAt = newest()
    if (collapsed) {
      wasCollapsed = true
      return
    }
    if (!hasActivity) return
    const now = Date.now()
    const should = shouldRefreshAttribution({
      collapsed,
      inflight,
      now,
      lastFetchAt,
      reexpanded: wasCollapsed,
      newestSeenAt: seenAt,
      lastFetchedNewestSeenAt: lastFetchedNewest,
    })
    wasCollapsed = false
    // fetchAttribution reads attribution.snapshot; untracked so the effect cannot
    // subscribe to (and re-run on) its own result.
    if (should) untrack(() => fetchAttribution(now, seenAt))
  })

  const kpi = (pick: (snapshot: OxpAttributionSnapshot) => string) => {
    const snapshot = attribution.snapshot
    return snapshot ? pick(snapshot) : "—"
  }

  const stamp = (activity: OxpParentActivitySummary) => {
    const parts = relativeStampParts(finite(activity.lastSeenAt), props.minuteNow())
    if (!parts) return ""
    if (parts.unit === "now") return language.t("oxpActivity.stamp.now")
    return language.t(`oxpActivity.stamp.${parts.unit}` as const, { value: parts.value })
  }

  // Constructing an Intl formatter is the expensive part of toLocaleString; build once per locale.
  const numberFormat = createMemo(() => new Intl.NumberFormat(language.intl()))
  const fmt = (value: number) => numberFormat().format(value)

  const rowTooltip = (activity: OxpParentActivitySummary) => {
    const calls = finite(activity.callCount)
    const failed = finite(activity.failureCount)
    const params = {
      calls: language.plural("oxpActivity.calls", calls, { count: calls }),
      failed: language.t("oxpActivity.failures", { count: fmt(failed) }),
      augmentation: fmt(finite(activity.augmentationCalls)),
      supervision: fmt(finite(activity.supervisionCalls)),
      delegation: fmt(finite(activity.delegationCalls)),
    }
    return failed > 0
      ? language.t("oxpActivity.row.summaryFailed", params)
      : language.t("oxpActivity.row.summary", params)
  }

  const planeTooltip = () => {
    const mix = totalMix()
    return language.t("oxpActivity.section.planeMix", {
      augmentation: language.t("oxpActivity.plane.augmentation"),
      augmentationCount: fmt(mix.augmentation),
      supervision: language.t("oxpActivity.plane.supervision"),
      supervisionCount: fmt(mix.supervision),
      delegation: language.t("oxpActivity.plane.delegation"),
      delegationCount: fmt(mix.delegation),
    })
  }

  const remaining = () => activities().length - state.limit

  return (
    <Show when={activities().length > 0}>
      <section data-slot="section" data-component="chats-oxp-section">
        <button type="button" data-slot="section-head" aria-expanded={!props.collapsed} onClick={() => props.onToggle()}>
          <IconV2 name="chevron-down" data-slot="section-chevron" />
          <span data-slot="section-label">{language.t("oxpActivity.section.label")}</span>
          <span data-slot="section-count">{activities().length}</span>
        </button>

        <Show when={!props.collapsed}>
          <div data-slot="section-body">
            <div
              data-slot="oxp-stats"
              role="group"
              aria-label={language.t("oxpActivity.section.statsLabel")}
              data-state={attribution.status}
              data-chat-tooltip-text={language.t("oxpActivity.section.windowHint")}
              data-chat-tooltip-placement="top"
            >
              <span data-slot="oxp-stat">
                <span data-slot="oxp-stat-label">{language.t("oxpActivity.attribution.oxpTokens")}</span>
                <span data-slot="oxp-stat-value">{kpi((s) => compact(s.totals.tokens))}</span>
              </span>
              <span data-slot="oxp-stat">
                <span data-slot="oxp-stat-label">{language.t("oxpActivity.attribution.totalTokens")}</span>
                <span data-slot="oxp-stat-value">{kpi((s) => compact(s.totals.estimatedTotalTokens))}</span>
              </span>
              <span data-slot="oxp-stat">
                <span data-slot="oxp-stat-label">{language.t("oxpActivity.attribution.calls")}</span>
                <span data-slot="oxp-stat-value">{kpi((s) => compact(s.totals.calls))}</span>
              </span>
            </div>
            <PlaneBar mix={totalMix()} slot="plane-mix" tooltip={planeTooltip()} />

            <For each={visible()}>
              {(activity) => {
                const failures = () => finite(activity.failureCount)
                const live = () => isLive(activity.lastSeenAt, props.minuteNow())
                // PlaneBar reads four fields; a memo evaluates the mix once per activity change.
                const mix = createMemo(() => planeMix(activity))
                return (
                  <button
                    type="button"
                    data-component="chats-oxp-activity-row"
                    data-activity-id={activity.id}
                    data-selected={props.selectedActivityID === activity.id ? "true" : undefined}
                    data-chat-tooltip-text={rowTooltip(activity)}
                    data-chat-tooltip-placement="right"
                    onClick={() => props.onOpen(activity.id)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setContextMenu({ activityID: activity.id, x: event.clientX, y: event.clientY })
                    }}
                  >
                    <span
                      data-slot="oxp-dot"
                      data-state={failures() > 0 ? "failed" : live() ? "live" : "idle"}
                      aria-hidden="true"
                    />
                    <span data-slot="oxp-title">
                      {activity.title ?? activity.lastRootAlias ?? language.t("oxpActivity.untitled")}
                    </span>
                    <PlaneBar mix={mix()} slot="row-mix" />
                    <span data-slot="oxp-calls">{compact(activity.callCount)}</span>
                    <span data-slot="oxp-failures" data-active={failures() > 0 ? "true" : undefined}>
                      <Show when={failures() > 0}>
                        <IconV2 name="warning" size="small" />
                        {compact(failures())}
                      </Show>
                    </span>
                    <span data-slot="oxp-time">{stamp(activity)}</span>
                  </button>
                )
              }}
            </For>

            <Show when={contextMenu()} keyed>
              {(cursor) => (
                <Show when={oxpActivity.activity(cursor.activityID)} keyed>
                  {(activity) => (
                    <Suspense fallback={null}>
                      <OxpActivityContextMenu
                        activity={activity}
                        cursor={cursor}
                        onOpen={() => props.onOpen(cursor.activityID)}
                        onOpenChange={(open) => {
                          if (!open) setContextMenu(undefined)
                        }}
                      />
                    </Suspense>
                  )}
                </Show>
              )}
            </Show>

            <Show when={remaining() > 0}>
              <button
                type="button"
                data-slot="more"
                onClick={() =>
                  setState("limit", (current) => Math.min(current + OXP_PAGE_STEP, activities().length))
                }
              >
                {language.t("oxpActivity.section.showMore", { count: Math.min(OXP_PAGE_STEP, remaining()) })}
              </button>
            </Show>
            <Show when={remaining() <= 0 && oxpActivity.hasMoreActivities()}>
              <button
                type="button"
                data-slot="more"
                disabled={oxpActivity.loadingMoreActivities()}
                onClick={() => {
                  void oxpActivity.loadOlderActivities().then(() => {
                    setState("limit", (current) => current + OXP_PAGE_STEP)
                  })
                }}
              >
                {oxpActivity.loadingMoreActivities()
                  ? language.t("oxpActivity.section.loadingOlder")
                  : language.t("oxpActivity.section.loadOlder")}
              </button>
            </Show>
          </div>
        </Show>
      </section>
    </Show>
  )
}
