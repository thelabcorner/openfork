import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useGlobal } from "./global"
import { safeQueryData } from "@/utils/safe-query-data"
import { useServer } from "./server"

export type SessionGroupEntry = {
  id: string
  name: string
  sessionIds: string[]
  position: number
  time: {
    created: number
    updated: number
  }
}

type SessionGroupResponse = {
  id: string
  name: string
  position: number
  time: { created: number; updated: number }
}

type SessionGroupDetailResponse = {
  group: SessionGroupResponse
  sessions: Array<{ id: string; title: string }>
}

type GroupClient = {
  request: (options: {
    url: string
    method: string
    parseAs?: "json" | "text"
    responseStyle?: "fields"
    throwOnError?: boolean
    body?: unknown
  }) => Promise<{ data: string; response: Response }>
}

function groupListQueryKey(scope: string) {
  return [scope, "session-groups"] as const
}

// Delegates to the configured SDK transport (baseUrl + auth + response
// interceptor) instead of hand-building URLs and Authorization headers. The
// interceptor throws when the server responds with the HTML app shell, so a
// missing route surfaces as an error rather than a JSON parse crash.
async function groupCall<T>(client: GroupClient, method: string, url: string, body?: unknown): Promise<T> {
  const result = await client.request({
    url,
    method,
    parseAs: "text",
    responseStyle: "fields",
    throwOnError: false,
    ...(body === undefined ? {} : { body }),
  })
  const response = result.response
  const text = result.data ?? ""
  if (!response.ok) {
    throw new Error(`session-group ${method} ${url} -> ${response.status} ${response.headers.get("content-type") ?? ""} ${response.url}`)
  }
  const trimmed = text.trim()
  if (trimmed.startsWith("<")) {
    throw new Error(
      `session-group ${method} ${url} -> ${response.status} ${response.headers.get("content-type") ?? ""} ${response.url}: ${trimmed.slice(0, 140)}`,
    )
  }
  try {
    const value = JSON.parse(text) as T & { data?: T }
    return value?.data ?? value
  } catch (cause) {
    throw new Error(`session-group ${method} ${url} -> ${response.status} ${response.headers.get("content-type") ?? ""} ${response.url}: ${text.slice(0, 140)}`)
  }
}

function transportOf(sdk: { client: unknown }): GroupClient {
  return (sdk.client as { client: GroupClient }).client
}

export const { use: useSessionGroups, provider: SessionGroupsProvider } = createSimpleContext({
  name: "SessionGroups",
  init: () => {
    const server = useServer()
    const global = useGlobal()
    const queryClient = useQueryClient()
    const scope = createMemo(() => `session-groups:${server.key}`)

    const serverSDK = createMemo(() => {
      const conn = server.current
      if (!conn) throw new Error("No server connected")
      return global.ensureServerCtx(conn).sdk
    })
    const client = createMemo(() => transportOf(serverSDK()))

    // Server-backed group list (TanStack Query) — global, no InstanceStore dep after backend fix.
    const groupsQuery = useQuery(() =>
      queryOptions({
        queryKey: groupListQueryKey(scope()),
        queryFn: () => groupCall<SessionGroupResponse[]>(client(), "GET", "/api/session-group"),
        enabled: !!server.current,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
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
    const [details, setDetails] = createStore<Record<string, SessionGroupDetailResponse>>({})
    const groupList = () => {
      const data = safeQueryData(groupsQuery, [] as SessionGroupResponse[])
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
      const promise = groupCall<SessionGroupDetailResponse>(client(), "GET", `/api/session-group/${groupId}`)
        .then((detail) => {
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
    const applyDetailBatch = (payload: SessionGroupDetailResponse[]) => {
      const next: Record<string, SessionGroupDetailResponse> = {}
      for (const detail of payload) next[detail.group.id] = detail
      // reconcile keeps object identity for unchanged groups so downstream
      // memos don't churn when only one group's membership moved.
      setDetails(reconcile(next))
    }
    const refreshDetails = (groupIds: string[]) => {
      if (groupIds.length === 0) return
      void groupCall<SessionGroupDetailResponse[]>(client(), "GET", "/api/session-group/details").then((payload) => {
        if (!Array.isArray(payload)) throw new Error("unexpected session-group details payload")
        applyDetailBatch(payload)
      }).catch(() => {
        for (const groupId of groupIds) fetchDetailDeduped(groupId)
      })
    }

    createEffect(() => {
      refreshDetails(groupList().map((group) => group.id).filter((id) => !details[id]))
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
          position: group.position,
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
      const existing = details[groupId]
      if (existing) return existing
      fetchDetailDeduped(groupId)
      return undefined
    }

    const createGroupMutation = useMutation(() => ({
      mutationFn: (name: string) => groupCall<SessionGroupResponse>(client(), "POST", "/api/session-group", { name }),
      onSuccess: () => {
        invalidate()
      },
    }))

    const renameGroupMutation = useMutation(() => ({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        groupCall<unknown>(client(), "PATCH", `/api/session-group/${id}`, { name }),
      onSuccess: (_, variables) => {
        invalidate(variables.id)
      },
    }))

    const deleteGroupMutation = useMutation(() => ({
      mutationFn: (id: string) => groupCall<unknown>(client(), "DELETE", `/api/session-group/${id}`),
      onSuccess: () => {
        invalidate()
      },
    }))

    const addSessionToGroupMutation = useMutation(() => ({
      mutationFn: ({ groupId, sessionId }: { groupId: string; sessionId: string }) =>
        groupCall<unknown>(client(), "POST", `/api/session-group/${groupId}/session`, { sessionId }),
      onSuccess: (_, variables) => {
        invalidate(variables.groupId)
      },
    }))

    const removeSessionFromGroupMutation = useMutation(() => ({
      mutationFn: ({ groupId, sessionId }: { groupId: string; sessionId: string }) =>
        groupCall<unknown>(client(), "DELETE", `/api/session-group/${groupId}/session/${sessionId}`),
      onSuccess: (_, variables) => {
        invalidate(variables.groupId)
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
