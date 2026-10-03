import type {
  OxpInvocationDetailInfo,
  OxpInvocationInfo,
  OxpInvocationPage,
  OxpParentActivitySummary,
} from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

type InvocationDetailState = {
  data?: OxpInvocationDetailInfo
  loaded: boolean
  loading: boolean
  error?: string
}

type DetailState = {
  items: OxpInvocationInfo[]
  more: boolean
  before?: OxpInvocationPage["before"]
  capped?: boolean
  loaded: boolean
  loading: boolean
  error?: string
}

const MAX_CACHED_ACTIVITY_DETAILS = 8
const MAX_CACHED_INVOCATIONS_PER_ACTIVITY = 2_000
const MAX_CACHED_INVOCATION_DETAILS = 128

// Live refresh cadence for an open activity.
//
// `oxpActivity.invocation.*` is published on the OXP host runtime's in-memory
// bus, and that runtime lives in the desktop sidecar — a different process from
// the server whose SSE stream this client consumes. Those frames therefore can
// never arrive here, which is why an open transcript used to sit still until it
// was remounted or refreshed by hand. SQLite is the authority the HTTP reads
// already go through, so an open transcript polls it while it is on screen; the
// event subscription below stays for the same-process activity events (rename,
// archive, delete) it does receive.
const LIVE_INVOCATION_INTERVAL_MS = 2_000
const LIVE_SUMMARY_INTERVAL_MS = 8_000

const emptyDetail = (): DetailState => ({
  items: [],
  more: false,
  loaded: false,
  loading: false,
})

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Replace the cached page without replacing the rows inside it.
 *
 * Every consumer of this list renders through `<For>`, which keys on object
 * identity — so handing it a freshly built array would dispose and rebuild
 * every tool row, collapsing whatever the reader had expanded, each time a
 * single call settles. Reconciling by `id` patches rows in place instead, and
 * a poll that found nothing new writes nothing at all.
 */
const sameRows = (items: OxpInvocationInfo[]) => reconcile(items, { key: "id" })

function finite(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Process-global OXP observability projection for the selected server.
 *
 * The sidebar consumes only compact parent summaries. Invocation history remains
 * lazy and bounded per explicitly opened activity. One shared event subscription
 * invalidates both surfaces; no row owns a timer, poller, or SSE connection.
 */
export const { use: useOxpActivity, provider: OxpActivityProvider } = createSimpleContext({
  name: "OxpActivity",
  init: () => {
    const serverSDK = useServerSDK()
    const [state, setState] = createStore({
      summaries: {} as Record<string, OxpParentActivitySummary>,
      details: {} as Record<string, DetailState>,
      invocationDetails: {} as Record<string, InvocationDetailState>,
      loaded: false,
      loading: false,
      loadingMoreSummaries: false,
      moreSummaries: false,
      summaryBeforeLastSeenAt: undefined as number | undefined,
      summaryBeforeID: undefined as string | undefined,
      error: undefined as string | undefined,
    })
    const sdk = createMemo(() => serverSDK().client.global)
    let disposed = false
    const detailRecency: string[] = []
    const invocationDetailRecency: string[] = []
    const invocationDetailRefreshes = new Map<string, Promise<void>>()
    const detailRefreshes = new Map<string, Promise<void>>()
    const detailDirty = new Set<string>()
    const summaryQueue = new Set<string>()
    const detailQueue = new Set<string>()

    const touchDetail = (activityID: string) => {
      const existing = detailRecency.indexOf(activityID)
      if (existing >= 0) detailRecency.splice(existing, 1)
      detailRecency.push(activityID)
      while (detailRecency.length > MAX_CACHED_ACTIVITY_DETAILS) {
        const evict = detailRecency.shift()
        if (!evict || evict === activityID) continue
        setState("details", (details) => {
          if (!(evict in details)) return details
          const next = { ...details }
          delete next[evict]
          return next
        })
        detailDirty.delete(evict)
        detailQueue.delete(evict)
      }
    }

    const touchInvocationDetail = (invocationID: string) => {
      const existing = invocationDetailRecency.indexOf(invocationID)
      if (existing >= 0) invocationDetailRecency.splice(existing, 1)
      invocationDetailRecency.push(invocationID)
      while (invocationDetailRecency.length > MAX_CACHED_INVOCATION_DETAILS) {
        const evict = invocationDetailRecency.shift()
        if (!evict || evict === invocationID) continue
        setState("invocationDetails", (details) => {
          if (!(evict in details)) return details
          const next = { ...details }
          delete next[evict]
          return next
        })
      }
    }

    const upsertSummary = (summary: OxpParentActivitySummary) =>
      setState("summaries", summary.id, summary)

    const drop = (activityID: string) => {
      setState("summaries", (summaries) => {
        if (!(activityID in summaries)) return summaries
        const next = { ...summaries }
        delete next[activityID]
        return next
      })
      setState("details", (details) => {
        if (!(activityID in details)) return details
        const next = { ...details }
        delete next[activityID]
        return next
      })
      const invocationIDs = state.details[activityID]?.items.map((item) => item.id) ?? []
      for (const invocationID of invocationIDs) {
        setState("invocationDetails", (details) => {
          if (!(invocationID in details)) return details
          const next = { ...details }
          delete next[invocationID]
          return next
        })
        const invocationRecency = invocationDetailRecency.indexOf(invocationID)
        if (invocationRecency >= 0) invocationDetailRecency.splice(invocationRecency, 1)
      }
      const recency = detailRecency.indexOf(activityID)
      if (recency >= 0) detailRecency.splice(recency, 1)
    }

    let backgroundSummaryRefresh: Promise<void> | undefined

    /**
     * @param options.background Poll on behalf of an on-screen surface: never
     *   raises the shared loading flag, never replaces already-paged summaries,
     *   and never paints a transient network error over data that is already
     *   good. Explicit refreshes keep the actionable states.
     */
    const refresh = async (options?: { background?: boolean }) => {
      const background = options?.background === true
      if (state.loading) return
      if (background && backgroundSummaryRefresh) return backgroundSummaryRefresh
      if (!background) setState("loading", true)
      const run = (async () => {
        try {
          const response = await sdk().oxpActivities(
            { limit: "100", includeArchived: "false" },
            { throwOnError: true },
          )
          const rows = response.data ?? []
          const tail = rows.at(-1)
          if (disposed) return
          if (background) {
            // A poll only ever sees the newest page. Merging keeps whatever
            // older pages the reader already asked for, and leaves their
            // cursor alone; removals arrive as `oxpActivity.removed`.
            for (const summary of rows) upsertSummary(summary)
            setState("loaded", true)
            return
          }
          const summaries: Record<string, OxpParentActivitySummary> = {}
          for (const summary of rows) summaries[summary.id] = summary
          setState("summaries", summaries)
          setState("moreSummaries", rows.length === 100)
          setState(
            "summaryBeforeLastSeenAt",
            tail ? finite(tail.lastSeenAt) : undefined,
          )
          setState("summaryBeforeID", tail?.id)
          setState("error", undefined)
          setState("loaded", true)
        } catch (error) {
          if (disposed || background) return
          setState("error", messageOf(error))
        } finally {
          if (!disposed && !background) setState("loading", false)
        }
      })()
      if (!background) return run
      backgroundSummaryRefresh = run.finally(() => {
        backgroundSummaryRefresh = undefined
      })
      return backgroundSummaryRefresh
    }

    const ensureLoaded = () => {
      if (state.loaded || state.loading) return
      void refresh()
    }

    const loadOlderActivities = async () => {
      if (
        state.loadingMoreSummaries ||
        !state.moreSummaries ||
        state.summaryBeforeLastSeenAt === undefined ||
        !state.summaryBeforeID
      )
        return
      setState("loadingMoreSummaries", true)
      try {
        const response = await sdk().oxpActivities(
          {
            limit: "100",
            includeArchived: "false",
            beforeLastSeenAt: String(state.summaryBeforeLastSeenAt),
            beforeID: state.summaryBeforeID,
          },
          { throwOnError: true },
        )
        if (disposed) return
        const rows = response.data ?? []
        for (const summary of rows) upsertSummary(summary)
        const tail = rows.at(-1)
        setState("moreSummaries", rows.length === 100)
        setState(
          "summaryBeforeLastSeenAt",
          tail ? finite(tail.lastSeenAt) : undefined,
        )
        setState("summaryBeforeID", tail?.id)
      } catch (error) {
        if (!disposed) setState("error", messageOf(error))
      } finally {
        if (!disposed) setState("loadingMoreSummaries", false)
      }
    }

    const summaryRefreshes = new Map<string, Promise<void>>()
    const summaryDirty = new Set<string>()
    const refreshOne = (activityID: string): Promise<void> => {
      const pending = summaryRefreshes.get(activityID)
      if (pending) {
        summaryDirty.add(activityID)
        return pending
      }
      const run = (async () => {
        try {
          const response = await sdk().oxpActivityGet(
            { activityID },
            { throwOnError: true },
          )
          if (disposed) return
          if (response.data) upsertSummary(response.data)
          else drop(activityID)
        } catch {
          // Live invalidation repair is best-effort. The explicit page/list
          // refresh paths retain the actionable error state.
        }
      })().finally(() => {
        summaryRefreshes.delete(activityID)
        if (!summaryDirty.delete(activityID) || disposed) return
        void refreshOne(activityID)
      })
      summaryRefreshes.set(activityID, run)
      return run
    }

    /**
     * @param options.background Poll on behalf of an on-screen transcript. A
     *   two-second tick must not flicker the timeline's loading affordances or
     *   replace a rendered transcript with an error banner, so a background
     *   pass leaves `loading` alone and only reports failure while there is
     *   still nothing to show.
     */
    const refreshInvocations = (
      activityID: string,
      options?: { background?: boolean },
    ): Promise<void> => {
      const background = options?.background === true
      touchDetail(activityID)
      const pending = detailRefreshes.get(activityID)
      if (pending) {
        // A background poll is satisfied by whatever pass is already running;
        // marking it dirty would queue a redundant round trip every tick.
        if (!background) detailDirty.add(activityID)
        return pending
      }
      if (!state.details[activityID])
        setState("details", activityID, emptyDetail())
      if (!background) setState("details", activityID, "loading", true)
      const run = (async () => {
        try {
          const response = await sdk().oxpInvocations(
            { activityID, limit: "100" },
            { throwOnError: true },
          )
          if (disposed || !detailRecency.includes(activityID)) return
          const page = response.data
          if (!page) return
          const previous = state.details[activityID] ?? emptyDetail()
          const fresh = new Map(page.items.map((item) => [item.id, item] as const))
          for (const item of previous.items)
            if (!fresh.has(item.id)) fresh.set(item.id, item)
          const items = [...fresh.values()].sort(
            (left, right) =>
              finite(right.startedAt) - finite(left.startedAt) ||
              right.id.localeCompare(left.id),
          ).slice(0, MAX_CACHED_INVOCATIONS_PER_ACTIVITY)
          const hadOlderPages = previous.loaded && previous.items.length > page.items.length
          const capped =
            fresh.size > MAX_CACHED_INVOCATIONS_PER_ACTIVITY ||
            previous.capped === true
          setState("details", activityID, "items", sameRows(items))
          setState("details", activityID, {
            more: capped ? false : hadOlderPages ? previous.more : page.more,
            before: hadOlderPages ? previous.before : page.before,
            capped,
            loaded: true,
            loading: false,
            error: undefined,
          })
        } catch (error) {
          if (disposed || !detailRecency.includes(activityID)) return
          if (background && state.details[activityID]?.loaded) return
          setState("details", activityID, "loading", false)
          setState("details", activityID, "error", messageOf(error))
        }
      })().finally(() => {
        detailRefreshes.delete(activityID)
        if (
          !detailDirty.delete(activityID) ||
          disposed ||
          !detailRecency.includes(activityID)
        )
          return
        void refreshInvocations(activityID)
      })
      detailRefreshes.set(activityID, run)
      return run
    }

    const ensureInvocations = (activityID: string) => {
      touchDetail(activityID)
      const detail = state.details[activityID]
      if (detail?.loaded || detail?.loading) return
      void refreshInvocations(activityID)
    }

    // ── Live refresh ───────────────────────────────────────────────────────
    //
    // One shared timer for every mounted OXP surface, ref-counted per activity,
    // so two windows onto the same transcript cost one poll. It runs only while
    // a surface is actually watching and the document is visible: a backgrounded
    // window must not keep a 2s round trip alive, and there is nothing to repaint
    // while it is occluded.
    const watched = new Map<string, number>()
    let watchers = 0
    let liveTimer: number | undefined
    let liveVisibility: (() => void) | undefined
    let summariesPolledAt = 0

    const liveTick = () => {
      if (disposed || !watchers) return
      if (typeof document !== "undefined" && document.hidden) return
      for (const activityID of watched.keys()) {
        void refreshOne(activityID)
        void refreshInvocations(activityID, { background: true })
      }
      const now = Date.now()
      if (now - summariesPolledAt < LIVE_SUMMARY_INTERVAL_MS) return
      summariesPolledAt = now
      void refresh({ background: true })
    }

    const stopLive = () => {
      if (liveTimer !== undefined) window.clearInterval(liveTimer)
      liveTimer = undefined
      liveVisibility?.()
      liveVisibility = undefined
    }

    const startLive = () => {
      if (liveTimer !== undefined || typeof window === "undefined") return
      liveTimer = window.setInterval(liveTick, LIVE_INVOCATION_INTERVAL_MS)
      if (typeof document === "undefined") return
      // Returning to an occluded window should show current state immediately
      // rather than after the next tick.
      const onVisibility = () => {
        if (document.hidden) return
        liveTick()
      }
      document.addEventListener("visibilitychange", onVisibility)
      liveVisibility = () => document.removeEventListener("visibilitychange", onVisibility)
    }

    /**
     * Follow an activity while a surface is showing it.
     *
     * Pass no ID to follow only the activity list (the landing page waiting for
     * a first conversation to appear). Returns the release function; callers are
     * expected to hand it straight to `onCleanup`.
     */
    const watch = (activityID?: string) => {
      watchers += 1
      if (activityID) {
        watched.set(activityID, (watched.get(activityID) ?? 0) + 1)
        void refreshInvocations(activityID, { background: true })
      }
      startLive()
      let released = false
      return () => {
        if (released) return
        released = true
        watchers = Math.max(0, watchers - 1)
        if (activityID) {
          const remaining = (watched.get(activityID) ?? 0) - 1
          if (remaining > 0) watched.set(activityID, remaining)
          else watched.delete(activityID)
        }
        if (watchers === 0) stopLive()
      }
    }

    const ensureInvocationDetail = (invocationID: string) => {
      touchInvocationDetail(invocationID)
      const current = state.invocationDetails[invocationID]
      if (current?.loaded || current?.loading) return
      const pending = invocationDetailRefreshes.get(invocationID)
      if (pending) return
      setState("invocationDetails", invocationID, {
        loaded: false,
        loading: true,
        error: undefined,
      })
      const run = (async () => {
        try {
          const response = await sdk().oxpInvocationDetail(
            { invocationID },
            { throwOnError: true },
          )
          if (disposed || !invocationDetailRecency.includes(invocationID)) return
          setState("invocationDetails", invocationID, {
            data: response.data ?? undefined,
            loaded: true,
            loading: false,
            error: undefined,
          })
        } catch (error) {
          if (disposed || !invocationDetailRecency.includes(invocationID)) return
          setState("invocationDetails", invocationID, {
            loaded: false,
            loading: false,
            error: messageOf(error),
          })
        }
      })().finally(() => invocationDetailRefreshes.delete(invocationID))
      invocationDetailRefreshes.set(invocationID, run)
    }

    const loadMore = async (activityID: string) => {
      touchDetail(activityID)
      const detail = state.details[activityID]
      if (!detail?.loaded || detail.loading || !detail.more || !detail.before)
        return
      setState("details", activityID, "loading", true)
      try {
        const response = await sdk().oxpInvocations(
          {
            activityID,
            limit: "100",
            beforeStartedAt: String(detail.before.startedAt),
            beforeID: detail.before.id,
          },
          { throwOnError: true },
        )
        const page = response.data
        if (!page || disposed || !detailRecency.includes(activityID)) return
        const merged = new Map(detail.items.map((item) => [item.id, item] as const))
        for (const item of page.items) merged.set(item.id, item)
        const sorted = [...merged.values()].sort(
            (left, right) =>
              finite(right.startedAt) - finite(left.startedAt) ||
              right.id.localeCompare(left.id),
          )
        const capped = sorted.length > MAX_CACHED_INVOCATIONS_PER_ACTIVITY
        setState(
          "details",
          activityID,
          "items",
          sameRows(sorted.slice(0, MAX_CACHED_INVOCATIONS_PER_ACTIVITY)),
        )
        setState("details", activityID, {
          more: capped ? false : page.more,
          before: page.before,
          capped,
          loaded: true,
          loading: false,
          error: undefined,
        })
      } catch (error) {
        if (!disposed && detailRecency.includes(activityID)) {
          setState("details", activityID, "loading", false)
          setState("details", activityID, "error", messageOf(error))
        }
      }
    }

    const rename = async (activityID: string, title?: string) => {
      const response = await sdk().oxpActivityUpdate(
        {
          activityID,
          globalOxpActivityPatch:
            title === undefined ? { clearTitle: true } : { title },
        },
        { throwOnError: true },
      )
      if (response.data) await refreshOne(activityID)
      return response.data
    }

    const archive = async (activityID: string, archived: boolean) => {
      const response = await sdk().oxpActivityUpdate(
        { activityID, globalOxpActivityPatch: { archived } },
        { throwOnError: true },
      )
      if (response.data) await refreshOne(activityID)
      return response.data
    }

    const remove = async (activityID: string) => {
      const response = await sdk().oxpActivityDelete(
        { activityID },
        { throwOnError: true },
      )
      if (response.data?.deleted) drop(activityID)
      return response.data?.deleted ?? false
    }

    let flushQueued = false
    const queueRepair = (activityID: string, detail: boolean) => {
      summaryQueue.add(activityID)
      if (detail && state.details[activityID]?.loaded) detailQueue.add(activityID)
      if (flushQueued) return
      flushQueued = true
      queueMicrotask(() => {
        flushQueued = false
        if (disposed) return
        const summaries = [...summaryQueue]
        const details = [...detailQueue]
        summaryQueue.clear()
        detailQueue.clear()
        for (const id of summaries) void refreshOne(id)
        for (const id of details) void refreshInvocations(id)
      })
    }

    createEffect(() => {
      const current = serverSDK()
      const unsubscribe = current.event.listen((envelope) => {
        const event = envelope.details
        switch (event.type) {
          case "oxpActivity.created":
          case "oxpActivity.updated":
            queueRepair(event.properties.activityID, false)
            return
          case "oxpActivity.removed":
            drop(event.properties.activityID)
            return
          case "oxpActivity.invocation.started":
          case "oxpActivity.invocation.settled":
          case "oxpActivity.link.added":
            queueRepair(event.properties.activityID, true)
            return
        }
      })
      onCleanup(unsubscribe)
    })

    onCleanup(() => {
      disposed = true
      stopLive()
      watched.clear()
      watchers = 0
      summaryQueue.clear()
      detailQueue.clear()
      summaryDirty.clear()
      detailDirty.clear()
      detailRecency.length = 0
      invocationDetailRecency.length = 0
      invocationDetailRefreshes.clear()
    })

    const activities = createMemo(() =>
      Object.values(state.summaries)
        .filter(
          (summary): summary is OxpParentActivitySummary =>
            !!summary && summary.archivedAt === undefined,
        )
        .sort(
          (left, right) =>
            finite(right.lastSeenAt) - finite(left.lastSeenAt) ||
            right.id.localeCompare(left.id),
        ),
    )

    return {
      activities,
      activity: (activityID: string) => state.summaries[activityID],
      detail: (activityID: string) => state.details[activityID],
      invocationDetail: (invocationID: string) => state.invocationDetails[invocationID],
      loaded: () => state.loaded,
      loading: () => state.loading,
      loadingMoreActivities: () => state.loadingMoreSummaries,
      hasMoreActivities: () => state.moreSummaries,
      error: () => state.error,
      ensureLoaded,
      loadOlderActivities,
      ensureInvocations,
      ensureInvocationDetail,
      watch,
      refresh,
      refreshOne,
      refreshInvocations,
      loadMore,
      rename,
      archive,
      remove,
    }
  },
})
