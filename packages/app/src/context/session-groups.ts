import type { SessionGroupDetail, SessionGroupInfo, SessionGroupMember } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useGlobal } from "./global"
import { safeQueryData } from "@/utils/safe-query-data"
import { useServer } from "./server"
import { useLanguage } from "./language"
import { showToast } from "@/utils/toast"
import { indexSessionGroupsByID } from "./session-group-index"
import { createSessionPreviewIndexCache } from "./session-group-preview-index"
import { createSessionGroupRequestGenerations } from "./session-group-request-generation"
import { createSessionGroupActivation } from "./session-group-activation"
import { fetchSessionGroupDetailsBounded } from "./session-group-fallback-queue"
import { mergeSessionGroupDetails, projectSessionGroupEntries } from "./session-group-entries"
import { createSessionGroupDetailCommitter } from "./session-group-detail-committer"
import { createRemoteSessionGroupSnapshots } from "./session-group-remote-snapshot"
import { createRemoteGroupObservers } from "./session-group-remote-observers"
import { eventInvalidatesSessionGroupNavigation } from "./session-group-event-filter"
export { eventInvalidatesSessionGroupNavigation } from "./session-group-event-filter"
import { createSessionGroupConnectionRevisions } from "./session-group-connection-identity"
import { ServerConnection } from "./server"
/**
 * Convert the lightweight group-member projection into an immutable Session
 * snapshot for structural navigation. Keep it out of the authoritative
 * session cache; older servers may still require the on-demand resolve path.
 */
export { sessionGroupMemberSession } from "./session-group-member-projection"

export type SessionGroupEntry = {
  id: string
  name: string
  sessionIds: string[]
  position: number
  kind: SessionGroupInfo["kind"]
  ownerPlugin?: string
  ownerRef?: string
  anchorSessionID?: string
  sessions: SessionGroupMember[]
  time: {
    created: number
    updated: number
  }
}

const EMPTY_REMOTE_GROUPS: SessionGroupEntry[] = []

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
    const activation = createSessionGroupActivation(() => setActive(true))
    onCleanup(activation.dispose)
    const activate = () => {
      if (!active()) activation.request()
    }
    const groupsQuery = useQuery(() => {
      // Capture the connection at query-option construction, not at deferred
      // queryFn execution time: an old-key request must never unexpectedly
      // run against whichever server became selected in the interim. Only
      // instantiate the SDK once TanStack actually executes the query.
      const connection = server.current
      return queryOptions({
        queryKey: groupListQueryKey(scope()),
        queryFn: async () => {
          if (!connection) return []
          return (await global.ensureServerCtx(connection).sdk.client.sessionGroup.list({ throwOnError: true })).data ?? []
        },
        enabled: !!connection && active(),
        staleTime: 5 * 60_000,
        gcTime: 10 * 60_000,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        // Never display another server's previous query rows when the selected
        // connection changes. Query-key cache still handles same-server reuse.
        placeholderData: () => [] as SessionGroupInfo[],
        retry: 1,
      })
    })

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
    // Membership data belongs to a server, not to a group ID globally. Keep
    // independent snapshots: another connection may use the same group IDs.
    // In-flight responses retain their initiating scope rather than writing
    // into whichever server happens to be selected when they settle.
    const [details, setDetails] = createStore<Record<string, Record<string, SessionGroupDetail>>>({})
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
    const detailRequests = createSessionGroupRequestGenerations()
    // Preserve active per-server caches, but discard retained group-member
    // trees when a connection is removed. Invalidating its generation also
    // prevents a late network completion from resurrecting the removed data.
    const detailConnections = createSessionGroupConnectionRevisions(ServerConnection.key)
    createEffect(() => {
      const { removed, changed } = detailConnections.update(global.servers.list())
      const invalid = [...removed, ...changed]
      if (!invalid.length) return
      for (const key of removed) detailRequests.forget(`session-groups:${key}`)
      for (const key of changed) detailRequests.advance(`session-groups:${key}`)
      setDetails(produce((cache) => {
        for (const key of invalid) delete cache[`session-groups:${key}`]
      }))
      // Same connection key may now represent another authenticated principal
      // or a new sidecar proxy URL. TanStack's old-key data must not leak
      // across that identity change even if its previous TTL has not expired.
      for (const key of changed) {
        void queryClient.resetQueries({ queryKey: groupListQueryKey(`session-groups:${key}`), exact: true })
      }
    })
    const fetchDetailDeduped = (
      groupId: string,
      requestScope = scope(),
      sdk = serverSDK(),
      generation = detailRequests.current(requestScope),
    ) => {
      const requestID = detailRequests.dedupeKey(requestScope, groupId, generation)
      const previous = inflightDetails.get(requestID)
      if (previous) return previous
      const promise = sdk
        .client.sessionGroup.get({ groupID: groupId }, { throwOnError: true })
        .then((response) => {
          const detail = response.data
          if (!detail || !detailRequests.valid(requestScope, generation)) return
          setDetails(requestScope, (previous) => ({ ...(previous ?? {}), [groupId]: detail }))
        })
        .catch(() => {
          // Leave the group without membership rather than failing the pane;
          // the next invalidate() retries it.
        })
        .finally(() => {
          inflightDetails.delete(requestID)
        })
      inflightDetails.set(requestID, promise)
      return promise
    }
    const applyDetailBatch = (requestScope: string, payload: SessionGroupDetail[]) => {
      const next: Record<string, SessionGroupDetail> = {}
      for (const detail of payload) next[detail.group.id] = detail
      // reconcile keeps object identity for unchanged groups so downstream
      // memos don't churn when only one group's membership moved.
      setDetails(requestScope, reconcile(next))
    }
    const refreshDetails = (groupIds: string[]) => {
      const requestScope = scope()
      if (groupIds.length === 0) {
        // A server with no groups must release its previous member snapshot;
        // otherwise deleting the final group leaves all of its old members
        // retained until the connection itself is removed. Invalidate any
        // outstanding old detail request before it can repopulate the cache.
        detailRequests.advance(requestScope)
        if (Object.keys(details[requestScope] ?? {}).length)
          setDetails(requestScope, reconcile({}))
        return
      }
      const sdk = serverSDK()
      const generation = detailRequests.advance(requestScope)
      void sdk
        .client.sessionGroup.listDetails({ throwOnError: true })
        .then((response) => {
          const payload = response.data ?? []
          if (!Array.isArray(payload)) throw new Error("unexpected session-group details payload")
          if (!detailRequests.valid(requestScope, generation)) return
          applyDetailBatch(requestScope, payload)
        })
        .catch(() => {
          if (!detailRequests.valid(requestScope, generation)) return
          // A late fallback targets its original server. Reconcile in
          // small batches rather than a write per individual completion.
          // The timed first batch also preserves progressive display if one
          // old-server request stalls near the end of a thousand-group list.
          const retainedIDs = new Set(groupIds)
          const existing = details[requestScope]
          if (existing && Object.keys(existing).some((id) => !retainedIDs.has(id))) {
            // Even when every get() fails, deleted groups must not accumulate
            // forever in the selected server's retained detail snapshot.
            setDetails(requestScope, reconcile(mergeSessionGroupDetails(existing, [], retainedIDs)))
          }
          const committer = createSessionGroupDetailCommitter<SessionGroupDetail>({
            valid: () => detailRequests.valid(requestScope, generation),
            publish: (fetched) => {
              setDetails(
                requestScope,
                // Stale/deleted groups were pruned once on fallback admission.
                // Checking the entire whitelist again at every 32-row
                // commit would reinstate O(groups × batches) overhead.
                reconcile(mergeSessionGroupDetails(details[requestScope] ?? {}, fetched)),
              )
            },
          })
          void fetchSessionGroupDetailsBounded(
            groupIds,
            async (groupId) => {
              const response = await sdk.client.sessionGroup.get({ groupID: groupId }, { throwOnError: true })
              if (response.data) committer.add(response.data)
            },
            () => detailRequests.valid(requestScope, generation),
          ).finally(() => committer.finish())
        })
    }

    createEffect(() => {
      if (!active()) return
      refreshDetails(groupList().map((group) => group.id))
    })

    // Build SessionGroupEntry list by merging group metadata with detail session IDs
    // Same suspension-guard: never read `groupsQuery.data` unless `isPending`
    // is false, otherwise the internal `createResource()` stays unresolved.
    const list = createMemo(() => projectSessionGroupEntries(groupList(), details[scope()] ?? {}))

    // Dense surfaces (home rows, tabs, and the session sidebar) ask for group
    // membership many times per render. Keep the materialized navigation
    // projection indexed once when authoritative group details change instead
    // of rescanning every group's member list for each row.
    const bySession = createMemo(() => {
      const index = new Map<string, SessionGroupEntry>()
      for (const group of list()) {
        for (const sessionID of group.sessionIds) {
          // Preserve list().find() semantics if legacy data places a session
          // in more than one group: the first group remains authoritative here.
          if (!index.has(sessionID)) index.set(sessionID, group)
        }
      }
      return index
    })

    const groupsByID = createMemo(() => indexSessionGroupsByID(list()))
    const byID = (groupId: string): SessionGroupEntry | undefined => groupsByID().get(groupId)
    // A normal createMemo here stays subscribed after the first-ever hover,
    // rebuilding on later group events even with zero inspectors visible.
    // Cache weakly by source revision without owning reactive subscriptions;
    // active callers still track list() within their own computation.
    const previewCache = createSessionPreviewIndexCache()
    const previewIndex = () => previewCache.get(list())

    // Remote tab inspectors use a single producer-owned snapshot per server;
    // nothing is fetched by simply mounting/laying out an inactive tab. The
    // first committed hover loads compact group metadata/details once for
    // that connection, then all its tabs share the result. The selected
    // server continues to use the existing live TanStack query above.
    const [remoteGroups, setRemoteGroups] = createStore<Record<string, SessionGroupEntry[]>>({})
    const remoteConnected = (key: ServerConnection.Key) =>
      global.servers.list().find((conn) => ServerConnection.key(conn) === key)
    const remoteSnapshots = createRemoteSessionGroupSnapshots({
      load: async (key, valid) => {
        const serverKey = key as ServerConnection.Key
        const connection = remoteConnected(serverKey)
        if (!connection) throw new Error("Disconnected server")
        // SDK only; an inspector should not bootstrap a remote Session Sync
        // tree merely to retrieve producer-owned group membership.
        const sdk = global.ensureServerSdk(connection)
        const [metadataResponse, batchedResponse] = await Promise.all([
          sdk.client.sessionGroup.list({ throwOnError: true }),
          sdk.client.sessionGroup.listDetails({ throwOnError: true }).catch(() => undefined),
        ])
        const metadata = Array.isArray(metadataResponse.data) ? metadataResponse.data : []
        let allDetails = Array.isArray(batchedResponse?.data) ? batchedResponse.data : undefined
        if (!allDetails && metadata.length) {
          const fetched: SessionGroupDetail[] = []
          await fetchSessionGroupDetailsBounded(
            metadata.map((group) => group.id),
            async (id) => {
              const result = await sdk.client.sessionGroup.get({ groupID: id }, { throwOnError: true })
              if (result.data) fetched.push(result.data)
            },
            () => valid() && !!remoteConnected(serverKey),
          )
          // A hover may have closed while legacy per-group requests were
          // queued. Do not publish a half-populated roster as a fresh cache.
          if (!valid()) throw new Error("Retired remote preview")
          allDetails = fetched
        }
        return projectSessionGroupEntries(
          metadata,
          Object.fromEntries((allDetails ?? []).map((detail) => [detail.group.id, detail])),
        )
      },
      publish: (key, groups) => setRemoteGroups(key, groups),
    })
    onCleanup(remoteSnapshots.dispose)
    const remoteObservers = createRemoteGroupObservers({
      // Burst-heavy Swarm sessions emit structural updates across multiple
      // tasks/ticks. One server-scoped refresh admission per 150ms prevents
      // invalidating its own in-flight remote group HTTP work every event.
      coalesceMs: 150,
      subscribe: (key, onEvent) => {
        const connection = remoteConnected(key as ServerConnection.Key)
        if (!connection) return () => {}
        const event = global.ensureServerSdk(connection).event
        // Subscribe before starting the shared socket, so even the first
        // structural frame cannot be lost during stream admission.
        const unlisten = event.listen((envelope) => onEvent(envelope.details.type))
        const release = event.acquire()
        return () => {
          unlisten()
          release()
        }
      },
      invalidates: eventInvalidatesSessionGroupNavigation,
      onChanged: (key) => {
        remoteSnapshots.refresh(key)
      },
      onUnwatched: (key) => {
        // Preserve successfully cached snapshots across hover streaks, but
        // abandon outstanding requests when the final preview closes.
        if (remoteSnapshots.pending(key)) remoteSnapshots.forget(key)
      },
    })
    onCleanup(remoteObservers.dispose)
    const remotePreview = (serverKey: ServerConnection.Key) => {
      if (serverKey === server.key) return list()
      if (!remoteConnected(serverKey)) return undefined
      const current = remoteGroups[serverKey]
      remoteSnapshots.ensure(serverKey)
      return current ?? EMPTY_REMOTE_GROUPS
    }
    // Drop snapshots for removed connections. An invalidated request token
    // prevents a late network completion from restoring the deleted state.
    const remoteConnections = createSessionGroupConnectionRevisions(ServerConnection.key)
    createEffect(() => {
      const { removed, changed } = remoteConnections.update(global.servers.list())
      const invalid = [...removed, ...changed]
      if (!invalid.length) return
      for (const key of invalid) {
        remoteSnapshots.forget(key)
        if (removed.includes(key)) remoteObservers.drop(key)
        else remoteObservers.refresh(key)
      }
      setRemoteGroups(produce((cache) => {
        for (const key of invalid) delete cache[key]
      }))
      // Open remote inspectors retain their observer lease across an endpoint
      // or auth rotation. Only those active consumers refresh the new source.
      for (const key of changed) {
        if (remoteObservers.watching(key)) remoteSnapshots.ensure(key)
      }
    })

    const groupForSession = (sessionId: string): SessionGroupEntry | undefined => {
      return bySession().get(sessionId)
    }

    // `groupId` is accepted for call-site compatibility but no longer scopes
    // the refresh: the batched details fetch costs one round-trip regardless,
    // so refreshing every group's membership is both simpler and fresher.
    const invalidate = (groupId?: string) => {
      queryClient.invalidateQueries({ queryKey: groupListQueryKey(scope()) })
      refreshDetails(groupList().map((group) => group.id))
    }

    // Virtual Swarm groups are projections over durable Swarm membership, so
    // they do not emit SessionGroup mutation events of their own. Invalidate
    // the generic navigation projection from the authoritative typed Swarm
    // events instead of polling. Coalesce same-tick event bursts (delegate emits
    // create/member/update events back-to-back) into one list/detail refresh.
    createEffect(() => {
      if (!active()) return
      const current = serverSDK()
      const observedScope = scope()
      let queued = false
      let disposed = false
      const unsubscribe = current.event.listen((envelope) => {
        if (!eventInvalidatesSessionGroupNavigation(envelope.details.type)) return
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          // The live selected server can change between a delivered event
          // and its coalesced refresh. Never re-route an old connection event
          // into the new server's membership query.
          if (disposed || scope() !== observedScope) return
          invalidate()
        })
      })
      onCleanup(() => {
        disposed = true
        unsubscribe()
      })
    })

    const fetchDetail = (groupId: string) => {
      activate()
      const existing = details[scope()]?.[groupId]
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
      previewIndex,
      remotePreview,
      remotePreviewIndex: (groups: readonly SessionGroupEntry[]) => previewCache.get(groups),
      observeRemotePreview: (key: ServerConnection.Key) => remoteObservers.watch(key),
      activateUrgent: activation.now,
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
