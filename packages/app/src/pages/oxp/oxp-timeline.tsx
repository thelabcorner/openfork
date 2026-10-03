import type { OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import type { DetailState } from "./oxp-invocation-detail"
import { OxpInvocationRow } from "./oxp-invocation-row"
import {
  ascending,
  isRunning,
  matchesFilter,
  matchesQuery,
  numeric,
  OXP_FILTERS,
  timelineEntries,
  type OxpFilter,
  type TimelineEntry,
} from "./oxp-presentation"
import { say } from "./oxp-phrase"

// Matches the session timeline's follow band: "all the way at the bottom"
// has to survive sub-pixel layout and a row that grew a line, but must not
// swallow a deliberate scroll away from the newest call.
const STICK_BAND_PX = 48

export type OxpTimelineSource = {
  items: readonly OxpInvocationInfo[]
  loaded: boolean
  loading: boolean
  more: boolean
  capped: boolean
  error?: string
}

/**
 * The transcript itself: filter bar, chronological rules, tool rows.
 *
 * Presentation-only by design — it receives an already-materialized projection
 * and a detail accessor, and owns no fetching of its own. That is what lets the
 * dev lab mount the exact component the product renders instead of a lookalike.
 */
export function OxpTimeline(props: {
  source: OxpTimelineSource
  /** Ticking clock. Only rows that are still running ever read it. */
  now: () => number
  invocationDetail: (invocationID: string) => DetailState | undefined
  linkBusy?: string
  onEnsureDetail: (invocationID: string) => void
  onLoadOlder: () => Promise<unknown>
  onOpenSession: (sessionID: string) => void
  onOpenScheduled: () => void
  /** Changing this resets scroll pinning — a different activity starts at its latest call. */
  resetKey?: string
}) {
  const language = useLanguage()
  const [filter, setFilter] = createSignal<OxpFilter>("all")
  const [query, setQuery] = createSignal("")

  const ordered = createMemo(() => ascending(props.source.items))
  const visible = createMemo(() => {
    const active = filter()
    const needle = query()
    return ordered().filter((item) => matchesFilter(item, active) && matchesQuery(item, needle))
  })
  // `For` keys on object identity, so handing it a freshly built entry list
  // would dispose and re-create every row — collapsing whatever the reader had
  // open — each time one call settles. Entries already carry a stable id, and
  // the store reconciles invocations in place, so returning the previous
  // wrapper whenever nothing inside it moved leaves only the rows that really
  // changed to be rebuilt. Rows still update live: they read the reconciled
  // invocation, not a copy of it.
  let priorEntries = new Map<string, TimelineEntry>()
  const entries = createMemo(() => {
    const next = new Map<string, TimelineEntry>()
    const result = timelineEntries(visible()).map((entry) => {
      const prior = priorEntries.get(entry.id)
      const stable = prior && unchangedEntry(prior, entry) ? prior : entry
      next.set(entry.id, stable)
      return stable
    })
    priorEntries = next
    return result
  })

  const counts = createMemo(() => {
    const result: Record<OxpFilter, number> = { all: 0, tools: 0, workers: 0, changes: 0, errors: 0 }
    for (const item of ordered()) {
      result.all += 1
      for (const option of OXP_FILTERS) {
        if (option.id === "all") continue
        if (matchesFilter(item, option.id)) result[option.id] += 1
      }
    }
    return result
  })

  // Ascending order puts the newest call at the bottom, like a session. Land
  // there on first paint and keep following only while the reader is already at
  // the bottom — scrolling up to read history must never be yanked back by a
  // call that just landed.
  let viewport: HTMLDivElement | undefined
  let pinned = true
  const onScroll = () => {
    if (!viewport) return
    pinned = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < STICK_BAND_PX
  }

  const follow = () => {
    if (!viewport || !pinned) return
    viewport.scrollTop = viewport.scrollHeight
  }

  // Following new calls and following a growing row are not the same thing.
  //
  // Appended rows must keep the reader at the newest call, and their final
  // height can land a frame after the entry list changed (icons, fonts), so
  // the transcript's own box is observed for a short window after an append.
  // Outside that window its growth is the reader's own doing — expanding a
  // call — and scrolling to the bottom there would shove the body they just
  // opened off-screen. The viewport's own resize always follows: a side pane
  // opening or the window growing should not silently break the pin.
  const APPEND_SETTLE_MS = 400
  let appendedAt = Number.NEGATIVE_INFINITY
  const observeContent = (element: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (performance.now() - appendedAt > APPEND_SETTLE_MS) return
      follow()
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }
  const observeViewport = (element: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => follow())
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }

  createEffect(
    on(
      () => props.resetKey,
      () => {
        pinned = true
      },
    ),
  )

  createEffect(
    on(
      () => [props.resetKey, props.source.loaded, entries().length] as const,
      () => {
        appendedAt = performance.now()
        if (!viewport || !pinned) return
        queueMicrotask(follow)
      },
    ),
  )

  // Older pages prepend, so the reader's current line has to stay put: capture
  // the distance from the bottom and restore it once the new rows are in.
  const loadOlder = async () => {
    const anchor = viewport ? viewport.scrollHeight - viewport.scrollTop : undefined
    pinned = false
    await props.onLoadOlder()
    if (anchor === undefined) return
    queueMicrotask(() => {
      if (!viewport) return
      viewport.scrollTop = viewport.scrollHeight - anchor
    })
  }

  const live = createMemo(() => props.source.items.some(isRunning))
  onCleanup(() => {
    viewport = undefined
  })

  return (
    <>
      <div data-slot="oxp-toolbar" role="toolbar" aria-label={language.t("oxpActivity.tab.title")}>
        <div data-slot="oxp-segments" role="group">
          <For each={OXP_FILTERS}>
            {(option) => (
              <button
                type="button"
                data-slot="oxp-segment"
                aria-pressed={filter() === option.id}
                onClick={() => setFilter(option.id)}
              >
                {language.t(option.key)}
                <Show when={option.id !== "all" && counts()[option.id] > 0}>
                  <span data-slot="oxp-segment-count">{counts()[option.id]}</span>
                </Show>
              </button>
            )}
          </For>
        </div>

        <input
          type="search"
          data-slot="oxp-search"
          value={query()}
          placeholder={language.t("oxpActivity.filter.search")}
          aria-label={language.t("oxpActivity.filter.search")}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <span data-slot="oxp-count" aria-live={live() ? "polite" : undefined}>
          {language.t("oxpActivity.filter.count", { visible: visible().length, total: ordered().length })}
        </span>
      </div>

      <ScrollView
        class="min-h-0 flex-1"
        viewportRef={(element) => {
          viewport = element
          observeViewport(element)
        }}
        onScroll={onScroll}
      >
        <div data-slot="oxp-timeline" ref={observeContent}>
          <Show
            when={props.source.loaded || props.source.items.length > 0}
            fallback={
              <div data-slot="oxp-state">
                <span data-slot="oxp-state-title">
                  {props.source.error
                    ? language.t("oxpActivity.timeline.error")
                    : language.t("oxpActivity.timeline.loading")}
                </span>
                <Show when={props.source.error}>
                  {(message) => <span data-slot="oxp-state-body">{message()}</span>}
                </Show>
              </div>
            }
          >
            <Show when={props.source.more}>
              <button
                type="button"
                data-slot="oxp-load-older"
                disabled={props.source.loading}
                onClick={() => void loadOlder()}
              >
                {props.source.loading
                  ? language.t("oxpActivity.timeline.loadingOlder")
                  : language.t("oxpActivity.timeline.loadOlder")}
              </button>
            </Show>

            <Show
              when={entries().length > 0}
              fallback={
                <div data-slot="oxp-state">
                  <span data-slot="oxp-state-title">
                    {ordered().length === 0
                      ? language.t("oxpActivity.timeline.empty")
                      : language.t("oxpActivity.timeline.noMatches")}
                  </span>
                </div>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <Show
                    when={entry.kind === "invocation" && entry}
                    fallback={
                      <div data-slot="oxp-rule" data-kind={entry.kind}>
                        <span data-slot="oxp-rule-label">
                          {entry.kind === "day"
                            ? dayLabel(entry.at, language.intl())
                            : entry.kind === "marker"
                              ? say(language, entry.label)
                              : ""}
                        </span>
                        <span data-slot="oxp-rule-line" />
                      </div>
                    }
                  >
                    {(row) => (
                      <OxpInvocationRow
                        item={row().item}
                        concurrent={row().concurrent}
                        now={props.now}
                        detail={props.invocationDetail(row().item.id)}
                        linkBusy={props.linkBusy}
                        onEnsureDetail={props.onEnsureDetail}
                        onOpenSession={props.onOpenSession}
                        onOpenScheduled={props.onOpenScheduled}
                      />
                    )}
                  </Show>
                )}
              </For>
            </Show>

            <Show when={props.source.capped}>
              <div data-slot="oxp-footnote">{language.t("oxpActivity.timeline.capped")}</div>
            </Show>
          </Show>
        </div>
      </ScrollView>
    </>
  )
}

/**
 * Entry ids already pin an entry to one invocation and one role, so only the
 * fields a later render can genuinely move need comparing. Marker labels are
 * derived from values (host run, epoch) that are fixed for their anchor call.
 */
function unchangedEntry(prior: TimelineEntry, next: TimelineEntry) {
  if (prior.kind !== next.kind) return false
  if (prior.kind === "invocation" && next.kind === "invocation")
    return prior.item === next.item && prior.concurrent === next.concurrent
  if (prior.kind === "day" && next.kind === "day") return prior.at === next.at
  return prior.kind === "marker"
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function dayLabel(at: number, locale: string) {
  let formatter = dayFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" })
    dayFormatters.set(locale, formatter)
  }
  return formatter.format(new Date(numeric(at)))
}
