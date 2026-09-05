import type { SessionGroupDetail, SessionGroupInfo, SessionGroupMember } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useGlobal } from "./global"
import { safeQueryData } from "@/utils/safe-query-data"
import { useServer } from "./server"
import { useLanguage } from "./language"
import { showToast } from "@/utils/toast"

export type SessionGroupEntry = {
  id: string
  name: string
  sessionIds: string[]
  position: number
  kind: "user" | "subagent" | "plugin"
  ownerPlugin?: string
  anchorSessionID?: string
  sessions: SessionGroupMember[]
  time: {
    created: number
    updated: number
  }
}

function groupListQueryKey(scope: string) {
  return [scope, "session-groups"] as const
}

export const { use: useSessionGroups, provider: SessionGroupsProvider } = createSimpleContext({
  name: "SessionGroups",
  init: () => {
    const server = useServer()
    const global = useGlobal()
    const language = useLanguage()
    const queryClient = useQueryClient()
    const scope = createMemo(() => `session-groups:${server.key}`)

    const serverSDK = createMemo(() => {
      const conn = server.current
      if (!conn) throw new Error("No server connected")
      return global.ensureServerCtx(conn).sdk
    })
    // Activate only when a rendered surface reads group state or invokes a
    // mutation. This keeps the cold draft route cheap without making the
    // provider return a permanently inert route-dependent stub.
    const [active, setActive] = createSignal(false)
    let activationQueued = false
    const activate = () => {
      if (active() || activationQueued) return
      activationQueued = true
      queueMicrotask(() => setTimeout(() => setActive(true), 300))
    }
    const groupsQuery = useQuery(() =>
      queryOptions({
        queryKey: groupListQueryKey(scope()),
        queryFn: async () => (await serverSDK().client.sessionGroup.list({ throwOnError: true })).data ?? [],
        enabled: !!server.current && active(),
        staleTime: 5 * 60_000,
        gcTime: 10 * 60_000,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        placeholderData: (prev) => prev ?? ([] as SessionGroupInfo[]),
        retry: 1,
      }),
    )

    /**
     * JSDOC: Avoid `groupsQuery.data` read when `isPending` is true.
     *
     * `@tanstack/solid-query` creates an internal `createResource()` per
     * query. Accessing `.data` while the resource is unresolved (cache empty,
     * `isPending` true) causes Solid's Suspense mechanism to park the read.
     * Inside `<Suspense>` routes this produces the multi-second blank screen.
     *
     * Pattern: gate on `isPending` first, fall back to `.data ?? []` only after.
     */
    const [details, setDetails] = createStore<Record<string, SessionGroupDetail>>({})
    const groupList = () => {
      activate()
      const data = safeQueryData(groupsQuery, [] as SessionGroupInfo[])
      // Servers older than the session-group feature answer unknown API paths
      // with an empty JSON object; treat any non-array payload as no groups.
      return Array.isArray(data) ? data : []
    }

    // One batched round-trip populates every group's membership (the server
    // buckets memberships in two total queries). If the backend predates the
    // batched route, fall back to per-group fetches — deduped so concurrent
    // list changes never duplicate an in-flight request.
    const inflightDetails = new Map<string, Promise<void>>()
    const fetchDetailDeduped = (groupId: string) => {
      if (inflightDetails.has(groupId)) return
      const promise = serverSDK()
        .client.sessionGroup.get({ groupID: groupId }, { throwOnError: true })
        .then((response) => {
          const detail = response.data
          if (!detail) return
          setDetails(groupId, detail)
        })
        .catch(() => {
          // Leave the group without membership rather than failing the pane;
          // the next invalidate() retries it.
        })
        .finally(() => {
          inflightDetails.delete(groupId)
        })
      inflightDetails.set(groupId, promise)
    }
    const applyDetailBatch = (payload: SessionGroupDetail[]) => {
      const next: Record<string, SessionGroupDetail> = {}
      for (const detail of payload) next[detail.group.id] = detail
      // reconcile keeps object identity for unchanged groups so downstream
      // memos don't churn when only one group's membership moved.
      setDetails(reconcile(next))
    }
    const refreshDetails = (groupIds: string[]) => {
      if (groupIds.length === 0) return
      void serverSDK()
        .client.sessionGroup.listDetails({ throwOnError: true })
        .then((response) => {
          const payload = response.data ?? []
          if (!Array.isArray(payload)) throw new Error("unexpected session-group details payload")
          applyDetailBatch(payload)
        })
        .catch(() => {
          for (const groupId of groupIds) fetchDetailDeduped(groupId)
        })
    }

    createEffect(() => {
      if (!active()) return
      refreshDetails(groupList().map((group) => group.id))
    })

    // Build SessionGroupEntry list by merging group metadata with detail session IDs
    // Same suspension-guard: never read `groupsQuery.data` unless `isPending`
    // is false, otherwise the internal `createResource()` stays unresolved.
    const list = createMemo(() => {
      return groupList().map((group) => {
        const detail = details[group.id]
        return {
          id: group.id,
          name: group.name,
          sessionIds: detail?.sessions?.map((s) => s.id) ?? [],
          position: typeof group.position === "number" ? group.position : 0,
          kind: group.kind,
          ownerPlugin: group.ownerPlugin,
          anchorSessionID: group.anchorSessionID,
          sessions: detail?.sessions ?? [],
          time: group.time,
        }
      })
    })

    const byID = (groupId: string): SessionGroupEntry | undefined => {
      return list().find((g) => g.id === groupId)
    }

    const groupForSession = (sessionId: string): SessionGroupEntry | undefined => {
      return list().find((g) => g.sessionIds.includes(sessionId))
    }

    // `groupId` is accepted for call-site compatibility but no longer scopes
    // the refresh: the batched details fetch costs one round-trip regardless,
    // so refreshing every group's membership is both simpler and fresher.
    const invalidate = (groupId?: string) => {
      queryClient.invalidateQueries({ queryKey: groupListQueryKey(scope()) })
      refreshDetails(groupList().map((group) => group.id))
    }

    const fetchDetail = (groupId: string) => {
      activate()
      const existing = details[groupId]
      if (existing) return existing
      fetchDetailDeduped(groupId)
      return undefined
    }

    const createGroupMutation = useMutation(() => ({
      mutationFn: async (name: string) =>
        (await serverSDK().client.sessionGroup.create({ name }, { throwOnError: true })).data,
      onSuccess: () => {
        invalidate()
      },
    }))

    const renameGroupMutation = useMutation(() => ({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        serverSDK().client.sessionGroup.rename({ groupID: id, name }, { throwOnError: true }),
      onSuccess: (_, variables) => {
        invalidate(variables.id)
      },
    }))

    const deleteGroupMutation = useMutation(() => ({
      mutationFn: (id: string) => serverSDK().client.sessionGroup.remove({ groupID: id }, { throwOnError: true }),
      onSuccess: () => {
        invalidate()
      },
    }))

    const addSessionToGroupMutation = useMutation(() => ({
      mutationFn: ({ groupId, sessionId }: { groupId: string; sessionId: string }) =>
        serverSDK().client.sessionGroup.addSession({ groupID: groupId, sessionId }, { throwOnError: true }),
      onSuccess: (_, variables) => {
        invalidate(variables.groupId)
      },
    }))

    const removeSessionFromGroupMutation = useMutation(() => ({
      mutationFn: ({ groupId, sessionId }: { groupId: string; sessionId: string }) =>
        serverSDK().client.sessionGroup.removeSession(
          { groupID: groupId, sessionID: sessionId },
          { throwOnError: true },
        ),
      onSuccess: (_, variables) => {
        invalidate(variables.groupId)
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : language.t("groupTab.lockedMembership")
        showToast({ title: language.t("sessionGroup.removeFrom"), description: message, variant: "error" })
      },
    }))

    return {
      /** Reactive signal of all groups with their session IDs */
      groups: list,
      list,
      byID,
      groupForSession,
      fetchDetail,

      /** Create a new group. Returns the created group with id/name. */
      createGroup: createGroupMutation.mutateAsync,
      /** Rename a group. */
      renameGroup: renameGroupMutation.mutateAsync,
      /** Delete a group. Sessions in the group are ungrouped. */
      deleteGroup: deleteGroupMutation.mutateAsync,
      /** Add a session to a group. */
      addSessionToGroup: addSessionToGroupMutation.mutateAsync,
      /** Remove a session from a group. */
      removeSessionFromGroup: removeSessionFromGroupMutation.mutateAsync,
    }
  },
})
