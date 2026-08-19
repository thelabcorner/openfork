import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "./global"
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

function groupDetailQueryKey(scope: string, groupId: string) {
  return [scope, "session-group", groupId] as const
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

    // Server-backed group list (TanStack Query)
    const groupsQuery = useQuery(() =>
      queryOptions({
        queryKey: groupListQueryKey(scope()),
        queryFn: () => groupCall<SessionGroupResponse[]>(client(), "GET", "/api/session-group"),
        enabled: !!server.current,
      }),
    )

    const [details, setDetails] = createStore<Record<string, SessionGroupDetailResponse>>({})
    createEffect(() => {
      for (const group of (groupsQuery.data ?? []) as SessionGroupResponse[]) {
        if (details[group.id]) continue
        void groupCall<SessionGroupDetailResponse>(client(), "GET", `/api/session-group/${group.id}`).then((detail) =>
          setDetails(group.id, detail),
        )
      }
    })

    // Build SessionGroupEntry list by merging group metadata with detail session IDs
    const list = createMemo(() => {
      const groups: SessionGroupResponse[] = groupsQuery.data ?? []
      return groups.map((group) => {
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

    const invalidate = (groupId?: string) => {
      queryClient.invalidateQueries({ queryKey: groupListQueryKey(scope()) })
      if (!groupId) return
      queryClient.invalidateQueries({ queryKey: groupDetailQueryKey(scope(), groupId) })
      void groupCall<SessionGroupDetailResponse>(client(), "GET", `/api/session-group/${groupId}`).then((detail) =>
        setDetails(groupId, detail),
      )
    }

    const fetchDetail = (groupId: string) => {
      const existing = queryClient.getQueryData<SessionGroupDetailResponse>(groupDetailQueryKey(scope(), groupId))
      if (existing) return existing
      void queryClient.prefetchQuery(
        queryOptions({
          queryKey: groupDetailQueryKey(scope(), groupId),
          queryFn: () => groupCall<SessionGroupDetailResponse>(client(), "GET", `/api/session-group/${groupId}`),
          staleTime: 30_000,
        }),
      )
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
