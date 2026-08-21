import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { type Accessor, createEffect, createMemo, createRoot, type JSX, startTransition } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useSessionGroups } from "@/context/session-groups"
import { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { type ProjectAvatarStatus } from "@opencode-ai/ui/v2/project-avatar-v2"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { DialogSessionGroupName } from "@/components/dialog-session-group"
import { Binary } from "@opencode-ai/core/util/binary"
import { archiveHomeSession } from "../home-session-archive"
import type { HomeController } from "./home-controller"

const HOME_SESSION_LIMIT = 64
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: string
  title: string
  sessions: HomeSessionRecord[]
  isUserGroup: boolean
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const sessionGroups = useSessionGroups()
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})
  const [selected, setSelected] = createStore<Record<string, boolean>>({})
  let selectionAnchor: string | undefined
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(directories)
    return directories(project)
  })
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_LIMIT,
      Date.now(),
    ),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => mergeGroupSessions(records(), language, sessionGroups))
  const selectedIds = () => Object.keys(selected).filter((id) => selected[id])
  const createGroup = async (name: string, sessionIds: string[] = []) => {
    const group = await sessionGroups.createGroup(name)
    await Promise.all(sessionIds.map((sessionId) => sessionGroups.addSessionToGroup({ groupId: group.id, sessionId })))
    clearSelection()
    return group.id
  }
  const toggleSelection = (sessionId: string, event: MouseEvent) => {
    const ids = allRecords().map((record) => record.session.id)
    const index = ids.indexOf(sessionId)
    if (event.shiftKey && selectionAnchor) {
      const anchor = ids.indexOf(selectionAnchor)
      if (anchor !== -1 && index !== -1) {
        const start = Math.min(anchor, index)
        const end = Math.max(anchor, index)
        setSelected(() => {
          const next: Record<string, boolean> = {}
          ids.slice(start, end + 1).forEach((id) => (next[id] = true))
          return next
        })
      }
    } else if (event.metaKey || event.ctrlKey) {
      setSelected(sessionId, !selected[sessionId])
      selectionAnchor = sessionId
    } else {
      setSelected(() => ({ [sessionId]: true }))
      selectionAnchor = sessionId
    }
  }
  const clearSelection = () => setSelected(() => ({}))
  const groupSelected = () => {
    const ids = selectedIds()
    if (ids.length === 0) return
    void dialog.show(() => <DialogSessionGroupName onSubmit={(name) => void createGroup(name, ids)} />)
  }
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  command.register("home.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  command.register("home.group.shortcuts", () => [
    {
      id: "sessionGroup.group",
      title: language.t("sessionGroup.addTo"),
      description: language.t("sessionGroup.addTo.description"),
      keybind: "mod+shift+g",
      hidden: true,
      onSelect: groupSelected,
    },
    {
      id: "sessionGroup.rename",
      title: language.t("sessionGroup.rename"),
      description: language.t("sessionGroup.rename.description"),
      keybind: "mod+shift+r",
      hidden: true,
      onSelect: () => {
        // Rename group when group tab is active
        // This is a placeholder - actual implementation depends on active tab
      },
    },
  ])

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const directoryKey = pathKey(session.directory)
        const project =
          home.project
            .list()
            .find(
              (item) =>
                pathKey(item.worktree) === directoryKey ||
                item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
            ) ?? projectForSession(session, home.project.list(), projectByID())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      archive: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        if ((await ctx.sdk.protocol) !== "v1") return
        await archiveHomeSession({
          server: ServerConnection.key(conn),
          session,
          archive: (sessionID) =>
            ctx.sdk.client.session.update({
              sessionID,
              directory: session.directory,
              time: { archived: Date.now() },
            }),
          remove: () =>
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            ),
          onError: (cause) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
    },
    group: {
      create: createGroup,
      groupSelected,
      rename: (id: string, name: string) => {
        void sessionGroups.renameGroup({ id, name })
      },
      remove: (id: string) => {
        void sessionGroups.deleteGroup(id)
      },
      addSession: (sessionId: string, groupId: string) => {
        const ids = selected[sessionId] ? selectedIds() : [sessionId]
        void Promise.all(ids.map((id) => sessionGroups.addSessionToGroup({ groupId, sessionId: id }))).then(clearSelection)
      },
      removeSession: (sessionId: string, groupId: string) => {
        void sessionGroups.removeSessionFromGroup({ groupId, sessionId })
      },
      removeFromAll: (sessionId: string) => {
        const ids = selected[sessionId] ? selectedIds() : [sessionId]
        void Promise.all(
          ids.flatMap((id) => {
            const group = sessionGroups.groupForSession(id)
            return group ? [sessionGroups.removeSessionFromGroup({ groupId: group.id, sessionId: id })] : []
          }),
        ).then(clearSelection)
      },
      toggleCollapsed: (id: string) => {
        setCollapsed(id, (prev) => !prev)
      },
      isCollapsed: (id: string) => !!collapsed[id],
      userGroups: () => sessionGroups.groups().map((g) => ({ id: g.id, name: g.name })),
      groupForSession: (sessionId: string) => sessionGroups.groupForSession(sessionId)?.id,
      openTab: (groupId: string) => {
        const conn = home.server.focused()
        if (!conn) return
        const serverKey = ServerConnection.key(conn)
        const existing = tabs.store.find((t) => t.type === "group" && t.groupId === groupId)
        if (existing) {
          tabs.select(existing)
          return
        }
        const tab = tabs.addGroupTab({ server: serverKey, groupId })
        tabs.select(tab)
      },
    },
    selection: {
      isSelected: (sessionId: string) => !!selected[sessionId],
      count: () => selectedIds().length,
      toggle: toggleSelection,
      clear: clearSelection,
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")
  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions, isUserGroup: false },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions, isUserGroup: false },
    { id: "older" as const, title: olderTitle, sessions: olderSessions, isUserGroup: false },
  ].filter((group) => group.sessions.length > 0)
}

function mergeGroupSessions(
  records: HomeSessionRecord[],
  language: ReturnType<typeof useLanguage>,
  sessionGroups: ReturnType<typeof useSessionGroups>,
): HomeSessionGroup[] {
  const userGroups = sessionGroups.groups()
  const sessionByID = new Map(records.map((r) => [r.session.id, r]))
  const groupedSessionIDs = new Set<string>()

  const userGroupResults: HomeSessionGroup[] = userGroups
    .map((entry) => {
      const sessions = entry.sessionIds
        .map((id) => sessionByID.get(id))
        .filter((r): r is HomeSessionRecord => r !== undefined)
      for (const session of sessions) groupedSessionIDs.add(session.session.id)
      return { id: entry.id, title: entry.name, sessions, isUserGroup: true as const }
    })
    .filter((g) => g.sessions.length > 0 || userGroups.some((u) => u.id === g.id))

  const remaining = records.filter((r) => !groupedSessionIDs.has(r.session.id))
  const timeGroups = groupSessions(remaining, language)

  return [...userGroupResults, ...timeGroups]
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: {
    unread: Accessor<boolean>
    status: Accessor<ProjectAvatarStatus | undefined>
    loading: Accessor<boolean>
    open: Accessor<boolean>
  }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    status: avatar.status,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
