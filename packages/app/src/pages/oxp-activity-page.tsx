import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { useOxpActivity } from "@/context/oxp-activity"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { legacySessionHref } from "@/utils/session-route"
import { OxpActivityHeader } from "@/pages/oxp/oxp-activity-header"
import { OxpTimeline, type OxpTimelineSource } from "@/pages/oxp/oxp-timeline"
import { isRunning } from "@/pages/oxp/oxp-presentation"
import { OxpAttributionPanel } from "@/pages/oxp/oxp-attribution-panel"
import "@/pages/oxp/oxp-activity.css"

/**
 * ChatGPT/OXP activity, read as a transcript.
 *
 * The page is a chronological reconstruction of what an external session did
 * inside OpenFork, not a telemetry view of it — same tool rows, same expansion
 * behaviour, same density as a live session.
 *
 * This module owns only the data path: route params, the store's compact
 * projection, the lazy per-call detail fetch, and the page-level actions. All
 * presentation lives in `@/pages/oxp/*`, which is what lets the dev lab render
 * the exact same components against fixtures.
 */
export function OxpActivityPage() {
  const params = useParams<{ activityID: string }>()
  const navigate = useNavigate()
  const store = useOxpActivity()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [busy, setBusy] = createSignal(false)
  const [linkBusy, setLinkBusy] = createSignal<string | undefined>()
  const [view, setView] = createSignal<"transcript" | "context">("transcript")

  const summary = createMemo(() => store.activity(params.activityID))
  const detail = createMemo(() => store.detail(params.activityID))
  const [attribution, attributionActions] = createResource(
    () =>
      view() === "context"
        ? {
            activityID: params.activityID,
            revision: summary()?.lastSeenAt ?? 0,
          }
        : undefined,
    async (key) => {
      const response = await serverSDK().client.global.oxpAttribution(
        { activityID: key.activityID },
        { throwOnError: true },
      )
      return response.data
    },
  )

  const source = createMemo<OxpTimelineSource>(() => {
    const current = detail()
    return {
      items: current?.items ?? [],
      loaded: current?.loaded ?? false,
      loading: current?.loading ?? false,
      more: current?.more ?? false,
      capped: current?.capped ?? false,
      error: current?.error ?? store.error(),
    }
  })

  // Two clocks, both shared, both conditional.
  //
  // A single page-wide one-second tick that every row reads is N re-renders per
  // second on a transcript that is almost entirely settled. The fast clock only
  // runs while something is actually running, and only running rows read it; the
  // coarse clock exists for the header's "12m ago" and never wakes a row.
  const anyRunning = createMemo(() => source().items.some(isRunning))
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
    store.ensureLoaded()
    if (view() === "transcript") store.ensureInvocations(params.activityID)
  })

  // Invocations are recorded by the OXP host inside the desktop sidecar, a
  // different process from the server whose event stream this renderer
  // consumes — so `oxpActivity.invocation.*` can never arrive here and an open
  // transcript has to follow the activity itself for as long as it is on
  // screen. Keyed on the activity alone: the released/re-acquired watch must
  // not be re-triggered by the store writes its own polling performs.
  createEffect(
    on(
      () => [params.activityID, view()] as const,
      ([activityID, currentView]) =>
        onCleanup(
          store.watch(
            currentView === "transcript" ? activityID : undefined,
          ),
        ),
    ),
  )

  const onViewKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
  ) => {
    let next: "transcript" | "context" | undefined
    if (event.key === "ArrowLeft" || event.key === "Home")
      next = "transcript"
    if (event.key === "ArrowRight" || event.key === "End") next = "context"
    if (!next) return
    event.preventDefault()
    setView(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(
        `[role="tab"][data-view="${next}"]`,
      )
      ?.focus()
  }

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
      // Opening a native session is a navigation affordance, not a data path. A
      // worker whose session was archived away must not raise a page error.
    } finally {
      setLinkBusy(undefined)
    }
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
        onRefresh={() => {
          if (view() === "context") {
            void attributionActions.refetch()
            return
          }
          void store.refreshInvocations(params.activityID)
        }}
      />

      <div
        data-slot="oxp-view-switch"
        role="tablist"
        aria-label={language.t("oxpActivity.view.label")}
      >
        <button
          type="button"
          role="tab"
          data-view="transcript"
          data-active={view() === "transcript" ? "true" : undefined}
          aria-selected={view() === "transcript"}
          tabindex={view() === "transcript" ? 0 : -1}
          onClick={() => setView("transcript")}
          onKeyDown={onViewKeyDown}
        >
          {language.t("oxpActivity.view.transcript")}
        </button>
        <button
          type="button"
          role="tab"
          data-view="context"
          data-active={view() === "context" ? "true" : undefined}
          aria-selected={view() === "context"}
          tabindex={view() === "context" ? 0 : -1}
          onClick={() => setView("context")}
          onKeyDown={onViewKeyDown}
        >
          {language.t("oxpActivity.view.context")}
        </button>
      </div>

      <Show
        when={view() === "context"}
        fallback={
          <OxpTimeline
            source={source()}
            now={fastNow}
            resetKey={params.activityID}
            linkBusy={linkBusy()}
            invocationDetail={(invocationID) => store.invocationDetail(invocationID)}
            onEnsureDetail={(invocationID) => store.ensureInvocationDetail(invocationID)}
            onLoadOlder={() => store.loadMore(params.activityID)}
            onOpenSession={(sessionID) => void openNativeSession(sessionID)}
            onOpenScheduled={() => navigate("/scheduled")}
          />
        }
      >
        <OxpAttributionPanel
          snapshot={attribution()}
          loading={attribution.loading}
          error={attribution.error}
          onRefresh={() => void attributionActions.refetch()}
        />
      </Show>
    </div>
  )
}

export function OxpActivityLandingPage() {
  const navigate = useNavigate()
  const store = useOxpActivity()
  const language = useLanguage()

  // Nothing to show yet is the normal first state here: the landing page is
  // what a reader sees while waiting for a first ChatGPT conversation to reach
  // OpenFork. Follow the activity list so that conversation opens itself.
  createEffect(() => {
    onCleanup(store.watch())
  })

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
