import { createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  sessionAutoAccept,
  resolveNewSessionAutoAccept,
  projectAutoAcceptPolicy,
  enqueuePolicyUpdate,
} from "./permission-auto-respond"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = getOwner()
    const states = new Map<
      ServerScope,
      { key: ServerConnection.Key; url: string; dispose: () => void; state: PermissionState }
    >()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const sdk = global.ensureServerSdk(conn)
      const existing = states.get(sdk.scope)
      if (
        existing &&
        existing.url === sdk.url &&
        global.servers.list().some((item) => ServerConnection.key(item) === existing.key)
      ) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({
          key,
          url: sdk.url,
          dispose,
          state: createServerPermissionState({ sdk, sync: () => global.ensureServerCtx(conn).sync }),
        }),
        owner ?? undefined,
      )
      states.set(sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return
      return selected().sync.session.lineage.peek(params.id)?.session.directory
    })

    createEffect(() => {
      const directory = activeDirectory()
      if (!directory) return
      selected().enableConfiguredDirectory(directory)
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(permission: PermissionRequest, directory?: string) {
        return selected().autoResponds(permission, directory)
      },
      isAutoAccepting(sessionID: string, directory?: string) {
        return selected().isAutoAccepting(sessionID, directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return selected().isAutoAcceptingDirectory(directory)
      },
      toggleAutoAccept(sessionID: string, directory: string) {
        selected().toggleAutoAccept(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        selected().toggleAutoAcceptDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        selected().enableAutoAccept(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        selected().disableAutoAccept(sessionID, directory)
      },
      autoAcceptForNewSession(directory?: string) {
        return selected().newSessionAutoAccept(directory, settings.general.autoAcceptPermissionsDefault())
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        return selected().isPermissionAllowAll(directory)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>
function createServerPermissionState(input: { sdk: ServerSDK; sync: () => ServerSync }) {
  const serverSync = () => input.sync()
  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      // Auto-accept preferences are not required to draw the shell. Desktop
      // storage is asynchronous; starting this read during provider mount adds
      // IPC/JSON/store hydration to the renderer startup wave. Permission
      // events are already held on `ready.promise` below, so deferring the read
      // preserves authorization semantics while moving persistence off first
      // paint.
      defer: true,
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value

        const data = value as Record<string, unknown>
        if (data.autoAccept) return value

        return {
          ...data,
          autoAccept:
            typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
              ? data.autoAcceptEdits
              : {},
        }
      },
    },
    createStore({
      autoAccept: {} as Record<string, boolean>,
    }),
  )

  function enableConfiguredDirectory(directory: string) {
    if (input.sdk.protocolKind() !== "v1") return
    if (meta.disposed || !ready()) return
    void syncPolicy(directory)
    // Permission is an observer of directory config, not a directory lifecycle
    // owner. The active route/bootstrap path populates config; reading the
    // preference here must not initialize plugins/LSP/config for a workspace.
    const [childStore] = serverSync().child(directory, { bootstrap: false })
    if (childStore.config.permission !== "allow") return
    const key = directoryAcceptKey(directory)
    if (store.autoAccept[key] !== undefined) return
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )
    void syncPolicy(directory, "*")
  }

  const MAX_POLICY_LOCATIONS = 2048
  const policySynced = new Map<string, string>()
  const policyInFlight = new Map<string, { signature: string; promise: Promise<boolean> }>()
  const policyQueue = new Map<string, Promise<boolean>>()
  function touchPolicyMap<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key)
    map.set(key, value)
    while (map.size > MAX_POLICY_LOCATIONS) map.delete(map.keys().next().value!)
  }
  const meta = { disposed: false }

  async function syncPolicy(directory: string, changedSessionID?: string) {
    if (meta.disposed || !ready()) return false
    if (input.sdk.protocolKind() !== "v1") return true
    const mode = changedSessionID === undefined ? "hydrate" : "patch"
    const policyKey = changedSessionID ?? "*"
    const autoAccept = mode === "hydrate" ? projectAutoAcceptPolicy(store.autoAccept, directory) : {
      [policyKey === "*" ? "*" : policyKey]: policyKey === "*"
        ? (store.autoAccept[directoryAcceptKey(directory)] ?? false)
        : (store.autoAccept[acceptKey(policyKey, directory)] ?? store.autoAccept[policyKey] ?? false),
    }
    const signature = `${mode}:${JSON.stringify(autoAccept)}`
    if (policySynced.get(directory) === signature) return true
    const inFlight = policyInFlight.get(directory)
    if (inFlight?.signature === signature) return inFlight.promise
    let promise!: Promise<boolean>
    promise = (async () => {
      try {
        const ok = await enqueuePolicyUpdate(policyQueue, directory, async () => {
          const result = await input.sdk.client.permission.autoAcceptPolicy({ directory, autoAccept, mode })
          return result.data === true
        }, MAX_POLICY_LOCATIONS)
        if (ok) touchPolicyMap(policySynced, directory, signature)
        return ok
      } catch {
        return false
      } finally {
        if (policyInFlight.get(directory)?.promise === promise) policyInFlight.delete(directory)
      }
    })()
    touchPolicyMap(policyInFlight, directory, { signature, promise })
    return promise
  }

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    input.sdk.api.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.permissionID,
        reply: request.response,
        location: request.directory ? { directory: request.directory } : undefined,
      })
      .catch(() => undefined)
  }

  function sessions(directory?: string) {
    const info = Object.values(serverSync().session.data.info).filter((session) => !!session)
    if (!directory) return info
    return [...info, ...serverSync().child(directory, { bootstrap: false })[0].session]
  }

  function isAutoAccepting(sessionID: string, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), { sessionID }, directory)
  }

  function isAutoAcceptingDirectory(directory: string) {
    return isDirectoryAutoAccepting(store.autoAccept, directory)
  }

  function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), permission, directory)
  }

  onCleanup(() => {
    meta.disposed = true
  })

  function enableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )
    void syncPolicy(directory, "*")

  }

  function disableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
      }),
    )
    void syncPolicy(directory, "*")
  }

  function setSessionAutoAccept(sessionID: string, directory: string, value: boolean) {
    if (meta.disposed) return
    const key = acceptKey(sessionID, directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = value
        delete draft.autoAccept[sessionID]
      }),
    )

    void syncPolicy(directory, sessionID)

  }

  function enable(sessionID: string, directory: string) {
    setSessionAutoAccept(sessionID, directory, true)
  }

  function disable(sessionID: string, directory?: string) {
    if (meta.disposed) return
    if (directory) {
      setSessionAutoAccept(sessionID, directory, false)
      return
    }
    setStore(
      produce((draft) => {
        draft.autoAccept[sessionID] = false
      }),
    )
  }

  const api = {
    ready: () => !meta.disposed && ready(),
    respond,
    autoResponds(permission: PermissionRequest, directory?: string) {
      if (meta.disposed) return false
      return shouldAutoRespond(permission, directory)
    },
    isAutoAccepting(sessionID: string, directory?: string) {
      if (meta.disposed) return false
      return isAutoAccepting(sessionID, directory)
    },
    isAutoAcceptingDirectory(directory: string) {
      if (meta.disposed) return false
      return isAutoAcceptingDirectory(directory)
    },
    toggleAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) {
        disable(sessionID, directory)
        return
      }

      enable(sessionID, directory)
    },
    toggleAutoAcceptDirectory(directory: string) {
      if (meta.disposed) return
      if (isAutoAcceptingDirectory(directory)) {
        disableDirectory(directory)
        return
      }
      enableDirectory(directory)
    },
    enableAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) return
      enable(sessionID, directory)
    },
    disableAutoAccept(sessionID: string, directory?: string) {
      if (meta.disposed) return
      disable(sessionID, directory)
    },
    /**
     * Materializes the effective new-session value as an explicit per-session
     * choice. Unlike `enableAutoAccept`, this never short-circuits, so a
     * session created while the default is OFF is stamped `false` and cannot
     * later inherit a directory-wide ON or a changed default.
     */
    initializeAutoAccept(sessionID: string, directory: string, value: boolean) {
      if (meta.disposed) return
      setSessionAutoAccept(sessionID, directory, value)
    },
    synchronizeAutoAccept(sessionID: string, directory: string) {
      return syncPolicy(directory, sessionID)
    },
    newSessionAutoAccept(directory: string | undefined, preference: boolean) {
      if (meta.disposed) return preference
      return resolveNewSessionAutoAccept(store.autoAccept, directory, preference)
    },
    directoryAutoAccept(directory: string) {
      if (meta.disposed) return undefined
      return store.autoAccept[directoryAcceptKey(directory)]
    },
    isPermissionAllowAll(directory: string) {
      if (meta.disposed) return false
      const [childStore] = serverSync().child(directory, { bootstrap: false })
      return childStore.config.permission === "allow"
    },
  }

  return {
    ...api,
    api,
    get sync() {
      return serverSync()
    },
    enableConfiguredDirectory,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = serverSync().child(directory, { bootstrap: false })
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}
