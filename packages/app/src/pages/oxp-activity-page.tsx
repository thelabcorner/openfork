import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useOxpActivity } from "@/context/oxp-activity"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { legacySessionHref } from "@/utils/session-route"
import { OxpActivityHeader } from "@/pages/oxp/oxp-activity-header"
import { OxpInvocationRow } from "@/pages/oxp/oxp-invocation-row"
import {
  ascending,
  isRunning,
  matchesFilter,
  matchesQuery,
  numeric,
  OXP_FILTERS,
  timelineEntries,
  type OxpFilter,
} from "@/pages/oxp/oxp-presentation"
import { say } from "@/pages/oxp/oxp-phrase"
import "@/pages/oxp/oxp-activity.css"

/**
 * ChatGPT/OXP activity, read as a transcript.
 *
 * The page is a chronological reconstruction of what an external session did
 * inside OpenFork, not a telemetry view of it — same tool rows, same expansion
 * behaviour, same density as a live session. Everything expensive stays behind
 * an explicit expand: the list consumes the compact server projection, and a
 * call's recorded request/result payload is fetched once, on first open, and
 * then served from the store's bounded cache.
 */
export function OxpActivityPage() {
  const params = useParams<{ activityID: string }>()
  const navigate = useNavigate()
  const store = useOxpActivity()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [filter, setFilter] = createSignal<OxpFilter>("all")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [linkBusy, setLinkBusy] = createSignal<string | undefined>()

  const summary = createMemo(() => store.activity(params.activityID))
  const detail = createMemo(() => store.detail(params.activityID))
  const items = createMemo(() => detail()?.items ?? [])

  // Two clocks, both shared, both conditional.
  //
  // A single page-wide one-second tick that every row reads is N re-renders per
  // second on a transcript that is almost entirely settled. The fast clock only
  // runs while something is actually running, and only running rows read it; the
  // coarse clock exists for the header's "12m ago" and never wakes a row.
  const anyRunning = createMemo(() => items().some(isRunning))
  const [fastNow, setFastNow] = createSignal(Date.now())
  const [minuteNow, setMinuteNow] = createSignal(Date.now())

  createEffect(() => {
    if (!anyRunning()) return
    setFastNow(Date.now())
    const timer = window.setInterval(() => setFastNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    const timer = window.setInterval(() => setMinuteNow(Date.now()), 60_000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    const activityID = params.activityID
    store.ensureLoaded()
    void store.refreshOne(activityID)
    store.ensureInvocations(activityID)
  })

  const ordered = createMemo(() => ascending(items()))
  const visible = createMemo(() => {
    const active = filter()
    const needle = query()
    return ordered().filter((item) => matchesFilter(item, active) && matchesQuery(item, needle))
  })
  const entries = createMemo(() => timelineEntries(visible()))

  const counts = createMemo(() => {
    const rows = ordered()
    const result: Record<OxpFilter, number> = { all: 0, tools: 0, workers: 0, changes: 0, errors: 0 }
    for (const item of rows) {
      result.all += 1
      for (const option of OXP_FILTERS) {
        if (option.id === "all") continue
        if (matchesFilter(item, option.id)) result[option.id] += 1
      }
    }
    return result
  })

  // Ascending order means the newest call is at the bottom, like a session. Land
  // there on first paint, and keep following only when the reader is already at
  // the bottom — scrolling up to read history must never be yanked back by a
  // call that just landed.
  let viewport: HTMLDivElement | undefined
  let pinned = true
  const atBottom = () =>
    !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64

  const onScroll = () => {
    pinned = atBottom()
  }

  createEffect(
    on(
      () => [params.activityID, detail()?.loaded, entries().length] as const,
      () => {
        if (!viewport || !pinned) return
        queueMicrotask(() => viewport?.scrollTo({ top: viewport.scrollHeight }))
      },
    ),
  )

  createEffect(
    on(
      () => params.activityID,
      () => {
        pinned = true
      },
    ),
  )

  const withBusy = async (run: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
    }
  }

  const openNativeSession = async (sessionID: string) => {
    setLinkBusy(sessionID)
    try {
      const response = await serverSDK().client.global.sessionGet({ sessionID }, { throwOnError: true })
      const session = response.data
      if (!session?.directory) return
      navigate(legacySessionHref(session.directory, session.id))
    } catch {
      // Opening a native session is a navigation affordance, not a data path.
      // A worker whose session was archived away should not raise a page error.
    } finally {
      setLinkBusy(undefined)
    }
  }

  // Older pages prepend, so the reader's current line has to stay put: capture
  // the distance from the bottom and restore it once the new rows are in.
  const loadOlder = async () => {
    const anchor = viewport ? viewport.scrollHeight - viewport.scrollTop : undefined
    pinned = false
    await store.loadMore(params.activityID)
    if (anchor === undefined) return
    queueMicrotask(() => {
      if (!viewport) return
      viewport.scrollTop = viewport.scrollHeight - anchor
    })
  }

  return (
    <div data-component="oxp-activity">
      <OxpActivityHeader
        activity={summary()}
        minuteNow={minuteNow()}
        busy={busy()}
        onRename={(title) => store.rename(params.activityID, title)}
        onArchive={() =>
          void withBusy(async () => {
            await store.archive(params.activityID, true)
            navigate("/oxp")
          })
        }
        onDelete={() =>
          void withBusy(async () => {
            await store.remove(params.activityID)
            navigate("/oxp")
          })
        }
        onRefresh={() => void store.refreshInvocations(params.activityID)}
      />

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
                <Show when={counts()[option.id] > 0 && option.id !== "all"}>
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
        <span data-slot="oxp-count">
          {language.t("oxpActivity.filter.count", { visible: visible().length, total: ordered().length })}
        </span>
      </div>

      <ScrollView class="min-h-0 flex-1" viewportRef={(element) => (viewport = element)} onScroll={onScroll}>
        <div data-slot="oxp-timeline">
          <Show
            when={detail()?.loaded || items().length > 0}
            fallback={
              <div data-slot="oxp-state">
                <span data-slot="oxp-state-title">
                  {detail()?.error || store.error()
                    ? language.t("oxpActivity.timeline.error")
                    : language.t("oxpActivity.timeline.loading")}
                </span>
                <Show when={detail()?.error ?? store.error()}>
                  {(message) => <span data-slot="oxp-state-body">{message()}</span>}
                </Show>
              </div>
            }
          >
            <Show when={detail()?.more}>
              <button
                type="button"
                data-slot="oxp-load-older"
                disabled={detail()?.loading}
                onClick={() => void loadOlder()}
              >
                {detail()?.loading
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
                        now={fastNow}
                        detail={store.invocationDetail(row().item.id)}
                        linkBusy={linkBusy()}
                        onEnsureDetail={(id) => store.ensureInvocationDetail(id)}
                        onOpenSession={(sessionID) => void openNativeSession(sessionID)}
                        onOpenScheduled={() => navigate("/scheduled")}
                      />
                    )}
                  </Show>
                )}
              </For>
            </Show>

            <Show when={detail()?.capped}>
              <div data-slot="oxp-footnote">{language.t("oxpActivity.timeline.capped")}</div>
            </Show>
          </Show>
        </div>
      </ScrollView>
    </div>
  )
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

export function OxpActivityLandingPage() {
  const navigate = useNavigate()
  const store = useOxpActivity()
  const language = useLanguage()

  createEffect(() => {
    store.ensureLoaded()
    if (!store.loaded()) return
    const next = store.activities()[0]
    if (next) navigate(`/oxp/activity/${next.id}`, { replace: true })
  })

  return (
    <div data-component="oxp-activity">
      <div class="flex min-h-0 flex-1 items-center justify-center">
        <div data-slot="oxp-state">
          <span data-slot="oxp-state-title">
            {store.loading() ? language.t("oxpActivity.landing.loading") : language.t("oxpActivity.landing.empty")}
          </span>
          <Show when={!store.loading()}>
            <span data-slot="oxp-state-body">{language.t("oxpActivity.landing.emptyDescription")}</span>
          </Show>
        </div>
      </div>
    </div>
  )
}
