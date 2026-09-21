import type {
  OxpInvocationInfo,
  OxpInvocationPage,
  OxpParentActivitySummary,
} from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

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

const emptyDetail = (): DetailState => ({
  items: [],
  more: false,
  loaded: false,
  loading: false,
})

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

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
      const recency = detailRecency.indexOf(activityID)
      if (recency >= 0) detailRecency.splice(recency, 1)
    }

    const refresh = async () => {
      if (state.loading) return
      setState("loading", true)
      try {
        const response = await sdk().oxpActivities(
          { limit: "100", includeArchived: "false" },
          { throwOnError: true },
        )
        const summaries: Record<string, OxpParentActivitySummary> = {}
        const rows = response.data ?? []
        for (const summary of rows) summaries[summary.id] = summary
        const tail = rows.at(-1)
        if (!disposed) {
          setState("summaries", summaries)
          setState("moreSummaries", rows.length === 100)
          setState(
            "summaryBeforeLastSeenAt",
            tail ? finite(tail.lastSeenAt) : undefined,
          )
          setState("summaryBeforeID", tail?.id)
          setState("error", undefined)
          setState("loaded", true)
        }
      } catch (error) {
        if (!disposed) setState("error", messageOf(error))
      } finally {
        if (!disposed) setState("loading", false)
      }
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

    const refreshInvocations = (activityID: string): Promise<void> => {
      touchDetail(activityID)
      const pending = detailRefreshes.get(activityID)
      if (pending) {
        detailDirty.add(activityID)
        return pending
      }
      if (!state.details[activityID])
        setState("details", activityID, emptyDetail())
      setState("details", activityID, "loading", true)
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
          setState("details", activityID, {
            items,
            more: capped ? false : hadOlderPages ? previous.more : page.more,
            before: hadOlderPages ? previous.before : page.before,
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
        setState("details", activityID, {
          items: sorted.slice(0, MAX_CACHED_INVOCATIONS_PER_ACTIVITY),
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
      summaryQueue.clear()
      detailQueue.clear()
      summaryDirty.clear()
      detailDirty.clear()
      detailRecency.length = 0
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
      loaded: () => state.loaded,
      loading: () => state.loading,
      loadingMoreActivities: () => state.loadingMoreSummaries,
      hasMoreActivities: () => state.moreSummaries,
      error: () => state.error,
      ensureLoaded,
      loadOlderActivities,
      ensureInvocations,
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
