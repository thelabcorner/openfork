import { base64Encode } from "@opencode-ai/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input/contracts"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"
import { chatsRoot } from "@opencode-ai/core/project/chat-paths"

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
  model?: ModelSelection
}) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const providers = useProviders(() => sdk().directory)
  const [catalogEnabled, setCatalogEnabled] = createSignal(false)
  onMount(() => {
    const timer = window.setTimeout(() => setCatalogEnabled(true), 400)
    onCleanup(() => window.clearTimeout(timer))
  })
  const agentsQuery = createQuery(() => ({
    ...input.queryOptions.agents(pathKey(sdk().directory)),
    enabled: catalogEnabled(),
    staleTime: 5 * 60_000,
    placeholderData: [],
  }))
  const globalProvidersQuery = createQuery(() => ({
    ...input.queryOptions.providers(null),
    enabled: catalogEnabled(),
    staleTime: 5 * 60_000,
  }))
  const providersQuery = createQuery(() => ({
    ...input.queryOptions.providers(pathKey(sdk().directory)),
    enabled: catalogEnabled(),
    staleTime: 5 * 60_000,
  }))

  return createMemo<PromptInputControls>(() => {
    return {
      agents: {
        available: sync().data.agent,
        options: local.agent.list().map((agent) => agent.name),
        current: local.agent.current()?.name ?? "",
        loading: agentsQuery.isLoading,
        visible: local.agent.visible(),
        select: local.agent.set,
      },
      model: {
        selection: input.model ?? local.model,
        paid: providers.paid().length > 0,
        /**
         * JSDOC: TanStack Solid-Query suspension trap (route-level black screen).
         *
         * `query.data` (even with `?? []`) reads the internal `createResource()`
         * that `@tanstack/solid-query` uses. When the cache is empty and the
         * query is `isPending`, that resource has not resolved yet — calling
         * the accessor inside a route covered by `<Suspense>` parks the entire
         * route until the query finishes (multi-second black screen on new
         * session or tab switch). The same applies to `isLoading` + `.data`.
         *
         * Safe pattern: check `isPending` ONLY. Never read `.data` while
         * `isPending` is true inside Suspense-covered render paths.
         */
        loading:
          (local.agent.visible() && agentsQuery.isPending) ||
          providersQuery.isPending ||
          globalProvidersQuery.isPending,
      },
      session: {
        id: input.sessionID(),
        tabs: layout.tabs(input.sessionKey),
      },
    }
  })
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const chatProject = () => {
    const root = chatsRoot()
    return {
      name: "Chat",
      id: "chats",
      worktree: root,
      sandboxes: [],
    } as const
  }

  const projects = createMemo(() => {
    const chat = chatProject()
    const list = server.list.length <= 1
      ? (search.draftId ? projectServerCtx().projects.list() : layout.projects.list())
      : server.list.flatMap((conn) => {
          const item = { key: ServerConnection.key(conn), name: serverName(conn) }
          return global
            .ensureServerCtx(conn)
            .projects.list()
            .map((project) => ({ ...project, server: item }))
        })
    return [chat, ...list]
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
