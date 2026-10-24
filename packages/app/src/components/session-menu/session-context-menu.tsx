import { createEffect, createMemo, createSignal, getOwner, lazy, onCleanup, runWithOwner, Show, Suspense, type ParentProps } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { useTabs, tabKey } from "@/context/tabs"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { sessionGroupMemberSession, useSessionGroups } from "@/context/session-groups"
import { useProviders } from "@/hooks/use-providers"
import { useForkUsage } from "@/context/fork-usage"
import { accountShortLabel, splitMultiAccountModelID } from "@/utils/model-account-identity"
import { showToast } from "@/utils/toast"
import { stopSession } from "@/utils/session-stop"
import { tabSessionState } from "../titlebar-tab-state"
import {
  isTitleRegenerationPending,
  sessionApiOf,
} from "../titlebar-tab-actions"
import { createSessionMenuModel, type SessionMenuWhere } from "./session-menu-model"
import { createSessionTitleRegeneration } from "../session-title-regeneration"
import type { MenuSectionDef } from "./menu-model"
import { MenuSectionsRenderer } from "./menu-renderer"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Identifier } from "@/utils/id"
import type { PromptModel, PromptSession } from "@/context/prompt-state"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useDirectoryPicker } from "@/components/directory-picker"
import { getProjectAvatarVariant } from "@/context/layout"
import { pathKey } from "@/utils/path-key"
import { CHAT_PROJECT_NAME } from "@opencode-ai/core/project/chat"
import { findChatProject, isChatProjectAlias, isReservedChatProjectPath } from "@/utils/chat-project"
import { isSessionPinned, toggleSessionPin } from "@/utils/pinned-sessions"
import type { SessionModelPickerRequest } from "./session-model-picker-runtime"
import { generateSessionGroupTitle } from "./session-group-title"
import { ContextMenuCursorTrigger } from "@/components/context-menu-cursor-trigger"

const SessionModelPicker = lazy(() =>
  import("./session-model-picker-runtime").then((m) => ({ default: m.SessionModelPicker })),
)

const DEFAULT_VARIANTS = ["default", "low", "medium", "high", "xhigh"] as const
let promptRuntime: Promise<typeof import("@/context/prompt-state")> | undefined
const loadPromptRuntime = () => (promptRuntime ??= import("@/context/prompt-state"))
let groupDialogRuntime: Promise<typeof import("../dialog-session-group")> | undefined
const loadGroupDialogRuntime = () => (groupDialogRuntime ??= import("../dialog-session-group"))
let renameDialogRuntime: Promise<typeof import("@/components/dialog-rename-session")> | undefined
const loadRenameDialogRuntime = () => (renameDialogRuntime ??= import("@/components/dialog-rename-session"))
let sessionExportRuntime: Promise<typeof import("@/utils/session-export")> | undefined
const loadSessionExportRuntime = () => (sessionExportRuntime ??= import("@/utils/session-export"))

const promptFromSession = (sess: Session | undefined): PromptModel | undefined => {
  const model = sess?.model
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.id, variant: model.variant }
}

type GroupMenuMember = { id: string; directory?: string; session?: Session }

async function runGroupAction<T>(items: T[], action: (item: T) => Promise<unknown>, concurrency = 4) {
  let next = 0
  let succeeded = 0
  let failed = 0
  const workers = Math.min(concurrency, items.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const item = items[next++]
        try {
          await action(item)
          succeeded++
        } catch {
          failed++
        }
      }
    }),
  )
  return { total: items.length, succeeded, failed }
}

// Tracks the last real pointer position so the model popover (which has no
// persistent visible trigger of its own) can spawn right where "Change
// model" was actually clicked — like a submenu flyout — instead of at the
// row's top-left corner.
let lastPointerPosition = { x: 0, y: 0 }
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      lastPointerPosition = { x: event.clientX, y: event.clientY }
    },
    { capture: true },
  )
}

export type SessionContextMenuProps = ParentProps<{
  where: SessionMenuWhere
  session?: Session | undefined
  server?: ServerConnection.Key
  /**
   * Cursor-anchored popup mode for virtualized/list hosts that cannot afford a
   * MenuV2.Context owner around every row. Supplying this renders one controlled
   * popup at the click position; the host can lazy-mount this component only
   * after a contextmenu event and unmount it when onOpenChange(false) fires.
   */
  cursor?: { x: number; y: number }
  /** Optional lifecycle hook for hosts that need to keep an enclosing hover
   * surface mounted while the portalled context menu is open. */
  onOpenChange?: (open: boolean) => void
  // Tab-specific
  tabId?: string
  isGroup?: boolean
  groupId?: string
  // Home/chats row-specific
  inGroupId?: string
  onOpen?: (opts?: { background?: boolean }) => void
  onArchive?: () => Promise<void> | void
  onChangeModel?: (request: SessionModelPickerRequest) => void
  onNewSessionInProject?: () => void
  onOpenProjectInExplorer?: () => void
  onCopyProjectPath?: () => void
  onForkConversation?: () => void
  // Group overrides — if not provided, generic sessionGroups mutations are used
  onAddToGroup?: (groupId: string) => void
  onRemoveFromGroup?: () => void
  onCreateGroup?: (name: string, sessionIds?: string[]) => Promise<string> | void
}>

export type { SessionModelPickerRequest } from "./session-model-picker-runtime"

/**
 * Unified session right-click menu — one shared architecture for tabs, home, and chats.
 * Perf: per-row wrapper (today) but all rendering is memoized; model factory is pure and
 * cheap. A single-container variant for large lists can swap in without changing the model.
 * One `MenuV2.Context` per instance, same `MenuSectionDef` type for session + file menus.
 */
export function SessionContextMenu(props: SessionContextMenuProps) {
  const language = useLanguage()
  const tabs = useTabs()
  const global = useGlobal()
  const dialog = useDialog()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const sessionGroups = useSessionGroups()
  // Directory-scoped catalog (same scoping the prompt surfaces use) so the menu resolves
  // model ids without opting into the global provider query. forkUsage supplies the
  // account/key labels without pulling in quota polling.
  const providers = useProviders(() => props.session?.directory)
  const forkUsage = useForkUsage()

  const sessionID = createMemo(() => props.session?.id)
  const serverCtx = createMemo(() => {
    if (!props.server) return undefined
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })

  const groupEntry = createMemo(() => (props.isGroup && props.groupId ? sessionGroups.byID(props.groupId) : undefined))
  const [groupTitlePending, setGroupTitlePending] = createSignal(false)
  createEffect(() => {
    const groupId = props.isGroup ? props.groupId : undefined
    if (groupId) sessionGroups.fetchDetail(groupId)
  })
  const groupMembers = createMemo<GroupMenuMember[]>(() => {
    const ctx = serverCtx()
    const seen = new Set<string>()
    return (groupEntry()?.sessions ?? []).flatMap((member) => {
      if (member.time?.archived != null || seen.has(member.id)) return []
      seen.add(member.id)
      const cached = ctx?.sync.session.peek(member.id)
      const session = cached ?? sessionGroupMemberSession(member) ?? (props.session?.id === member.id ? props.session : undefined)
      return [{ id: member.id, directory: member.directory ?? session?.directory, session }]
    })
  })

  const state = createMemo(() => tabSessionState(serverCtx(), sessionID()))
  const pendingRegenerate = createMemo(() => isTitleRegenerationPending(sessionID()))

  const tabIndex = createMemo(() => {
    if (!props.tabId) return -1
    return tabs.store.findIndex((item) => tabKey(item) === props.tabId)
  })
  const tabCount = createMemo(() => tabs.store.length)

  const userGroups = () =>
    sessionGroups
      .groups()
      .filter((g) => g.kind === "user")
      .map((g) => ({ id: g.id, name: g.name }))
  const isInGroup = createMemo(() => !!props.inGroupId)
  const membershipLocked = createMemo(() => {
    const groupID = props.inGroupId
    const sid = sessionID()
    if (!groupID || !sid) return false
    const group = sessionGroups.byID(groupID)
    // A managed group is an ownership boundary even when its anchor membership
    // itself is not marked locked. In particular, removing the root of an
    // auto-subagent group strands its locked descendants under a structure the
    // UI can no longer explain. Treat the entire managed group as immutable
    // from generic session menus; its owning subsystem remains free to mutate it.
    if (group && group.kind !== "user") return true
    return group?.sessions.find((member) => member.id === sid)?.locked ?? false
  })

  // Default control actions (stop/pause/resume/regenerate) — hosts may override via props actions
  const api = createMemo(() => sessionApiOf(serverCtx()))

  const stop = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void stopSession(a, id).catch((error) => showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    }))
  }
  const pause = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void a.pause({ sessionID: id })
  }
  const resume = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void a.resume({ sessionID: id })
  }
  const titleRegeneration = createSessionTitleRegeneration({
    sessionID,
    session: () => props.session,
    api,
    server: () => props.server,
  })
  const regenerateTitle = () => titleRegeneration.run()

  const [pinVersion, setPinVersion] = createSignal(0)
  const isPinned = createMemo(() => {
    pinVersion()
    return isSessionPinned(sessionID())
  })
  const togglePin = () => {
    const sid = sessionID()
    if (!sid) return
    const pinned = toggleSessionPin(sid)
    setPinVersion((n) => n + 1)
    showToast({ title: language.t(pinned ? "toast.session.pin.success.title" : "toast.session.unpin.success.title") })
  }

  const copySessionId = () => {
    const sid = sessionID()
    if (!sid) return
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    void clipboard
      ?.writeText(sid)
      .then(() => showToast({ title: language.t("toast.session.copyId.success.title"), variant: "success" }))
      .catch(() => showToast({ title: language.t("toast.session.copyId.failed.title"), variant: "error" }))
  }

  const renameSession = () => {
    const sid = sessionID()
    const sess = props.session
    const ctx = serverCtx()
    if (!sid || !sess || !ctx) return
    void loadRenameDialogRuntime().then(({ DialogRenameSession }) =>
      dialog.show(() => (
        <DialogRenameSession
          initial={sess.title ?? ""}
          onSubmit={(title) => {
            ctx.sync.session.remember({ ...sess, title })
            void ctx.sdk.api.session
              .rename({ sessionID: sid, title })
              .then(() => showToast({ title: language.t("toast.session.rename.success.title"), variant: "success" }))
              .catch((err: unknown) => {
                ctx.sync.session.remember({ ...sess, title: sess.title })
                showToast({
                  title: language.t("toast.session.rename.failed.title"),
                  description: err instanceof Error ? err.message : undefined,
                  variant: "error",
                })
              })
          }}
        />
      )),
    )
  }

  const exportJson = () => {
    const sid = sessionID()
    const ctx = serverCtx()
    if (!sid || !ctx) return
    void loadSessionExportRuntime().then(({ fetchSessionExport, sessionExportFilename, downloadSessionExport }) =>
      fetchSessionExport({ sessionID: sid, client: ctx.sdk.client })
      .then(async (data) => {
        const saved = await downloadSessionExport(
          sessionExportFilename(data.info),
          data,
          platform.compressExport?.bind(platform),
        )
        showToast({
          title: language.t("toast.session.export.success.title"),
          description: language.t("toast.session.export.success.description", { filename: saved }),
          variant: "success",
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("toast.session.export.failed.title"),
          description: err instanceof Error ? err.message : language.t("toast.session.export.failed.description"),
          variant: "error",
        })
      }),
    )
  }

  const changeProject = createMemo(() => {
    const sess = props.session
    const ctx = serverCtx()
    if (!sess || !ctx) return undefined
    const current = pathKey(sess.directory)
    // Same options as the new-session project selector. Chat is resolved from
    // the server project catalog so a renderer never manufactures a local path
    // for a remote server (or guesses USERPROFILE on Windows).
    type ProjectOption = {
        worktree: string
        name?: string
        id?: string
        icon?: { color?: string; url?: string; override?: string }
        sandboxes?: string[]
      }
    const known = ctx.projects.list() as ProjectOption[]
    const canonical = findChatProject(ctx.sync.data.project as ProjectOption[])
    const source: ProjectOption[] = canonical
      ? [
          {
            ...(known.find((project) => isChatProjectAlias(project, canonical)) ?? canonical),
            ...canonical,
            name: canonical.name ?? CHAT_PROJECT_NAME,
            worktree: canonical.worktree,
          },
          ...known.filter((project) => !isChatProjectAlias(project, canonical)),
        ]
      : known.filter((project) => project.id !== "chats" && !isReservedChatProjectPath(project.worktree))

    const belongsTo = (session: Session | undefined, project: ProjectOption | undefined) => {
      if (!session || !project) return false
      // projectID is authoritative for generated Chat scratch directories and
      // other locations that are intentionally not equal to the project root.
      if (session.projectID && project.id) return session.projectID === project.id
      const directory = pathKey(session.directory)
      return (
        pathKey(project.worktree) === directory ||
        project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory) === true
      )
    }

    const moveSessionTo = (worktree: string) => {
      const sid = sessionID()
      const target = source.find((project) => pathKey(project.worktree) === pathKey(worktree))
      if (!sid || belongsTo(sess, target) || (!target && pathKey(worktree) === current)) return

      void (async () => {
        try {
          await ctx.sdk.client.experimental.controlPlane.moveSession({
            sessionID: sid,
            destination: { directory: worktree },
            moveChanges: false,
          })
        } catch (err) {
          showToast({
            title: language.t("toast.session.move.failed.title"),
            description: err instanceof Error ? err.message : undefined,
            variant: "error",
          })
          return
        }

        // The move endpoint returns no relocated session payload. Usually the
        // session.next.moved stream event has already repaired the shared cache;
        // if transport delivery is a beat behind, one tiny forced metadata GET
        // gives us the server-assigned location (critical for Chat scratch dirs)
        // without reloading every project's session list.
        let info = ctx.sync.session.peek(sid)
        const associated = target
          ? belongsTo(info, target)
          : !!info && pathKey(info.directory) === pathKey(worktree)
        if (!associated) {
          try {
            info = await ctx.sync.session.resolve(sid, { force: true })
          } catch {
            info = undefined
          }
        }

        if (info) {
          const indexed = ctx.sync.project.reindexSession(info)
          // Newly-added projects may not have a passive child store yet. Only
          // in that uncommon case hydrate the single selected project, then
          // replay the local index repair. Existing-project moves stay request
          // free once the move event has landed.
          if (!indexed) {
            await ctx.sync.project.loadSessions(worktree, { priority: "critical" }).catch(() => undefined)
            const refreshed = ctx.sync.session.peek(sid)
            if (refreshed) ctx.sync.project.reindexSession(refreshed)
          }
        }

        showToast({ title: language.t("toast.session.move.success.title"), variant: "success" })
      })()
    }

    const projects = source.map((project) => {
      const label = displayName(project)
      const selected = belongsTo(sess, project)
      return {
        worktree: project.worktree,
        label,
        current: selected,
        disabled: selected,
        avatar: {
          fallback: label,
          src: getProjectAvatarSource(project.id, project.icon),
          variant: getProjectAvatarVariant(project.icon?.color),
        },
      }
    })
    return {
      projects,
      searchPlaceholder: language.t("session.new.project.search"),
      onSelect: moveSessionTo,
      onAddProject: () => {
        const sid = sessionID()
        const conn = props.server
          ? global.servers.list().find((item) => ServerConnection.key(item) === props.server)
          : undefined
        if (!sid || !conn) return
        pickDirectory({
          server: conn,
          title: language.t("command.project.open"),
          onSelect: (result) => {
            const directory = Array.isArray(result) ? result[0] : result
            if (!directory) return
            ctx.projects.open(directory)
            ctx.projects.touch(directory)
            moveSessionTo(directory)
          },
        })
      },
    }
  })

  const close = () => {
    const i = tabIndex()
    if (i >= 0) tabs.closeTab(i)
  }
  const closeLeft = () => {
    const i = tabIndex()
    if (i > 0) tabs.closeTabsLeftOf(i)
  }
  const closeRight = () => {
    const i = tabIndex()
    if (i >= 0 && i < tabCount() - 1) tabs.closeTabsRightOf(i)
  }
  const closeOthers = () => {
    const i = tabIndex()
    if (i >= 0) tabs.closeOtherTabs(i)
  }
  const closeAll = () => tabs.closeAllTabs()

  const renameGroup = () => {
    const id = props.groupId
    const group = id ? sessionGroups.byID(id) : undefined
    if (!id || !group) return
    void loadGroupDialogRuntime().then(({ DialogSessionGroupName }) =>
      dialog.show(() => (
        <DialogSessionGroupName
          initial={group.name}
          onSubmit={(name) => {
            void sessionGroups.renameGroup({ id, name }).catch((error: unknown) =>
              showToast({
                title: language.t("sessionGroup.rename"),
                description: error instanceof Error ? error.message : undefined,
                variant: "error",
              }),
            )
          }}
        />
      )),
    )
  }
  const addSessions = () => {
    const sid = sessionID()
    const current = props.groupId
    if (!sid || !current) return
    const choices = sessionGroups.groups().filter((group) => group.id !== current && group.kind === "user")
    void loadGroupDialogRuntime().then(({ DialogSessionGroupPicker }) =>
      dialog.show(() => (
        <DialogSessionGroupPicker
          groups={choices.map((group) => ({ id: group.id, name: group.name }))}
          onSelect={(groupId) => {
            void sessionGroups.addSessionToGroup({ groupId, sessionId: sid }).catch((error: unknown) =>
              showToast({
                title: language.t("sessionGroup.addSessions"),
                description: error instanceof Error ? error.message : undefined,
                variant: "error",
              }),
            )
          }}
          onCreate={() => onCreateGroupDialog()}
        />
      )),
    )
  }

  // PermissionProvider is available at the app root. SessionContextMenu itself
  // only has three hosts (titlebar, home, Chat sidebar), all outside the routed
  // LocalProvider. Keep model/prompt runtime work demand-loaded by the actions
  // that actually need it instead of importing the entire directory graph here.
  let permission: ReturnType<typeof usePermission> | undefined
  try {
    permission = usePermission()
  } catch {
    permission = undefined
  }

  const [modelPicker, setModelPicker] = createSignal<SessionModelPickerRequest | null>(null)
  const [contextOpen, setContextOpen] = createSignal(!!props.cursor)
  const [surfaceHolds, setSurfaceHolds] = createSignal(0)
  let reportedOpen = false

  createEffect(() => {
    const active = contextOpen() || surfaceHolds() > 0 || !!modelPicker()
    if (active === reportedOpen) return
    reportedOpen = active
    props.onOpenChange?.(active)
  })
  onCleanup(() => {
    if (reportedOpen) props.onOpenChange?.(false)
  })

  const holdSurface = async <T,>(work: () => Promise<T>): Promise<T> => {
    setSurfaceHolds((value) => value + 1)
    try {
      return await work()
    } finally {
      setSurfaceHolds((value) => Math.max(0, value - 1))
    }
  }

  const isAutoAccepting = createMemo(() => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess || !permission) return false
    return permission.isAutoAccepting(sid, sess.directory)
  })

  const groupMenuState = createMemo(() => {
    const ctx = serverCtx()
    const members = groupMembers()
    const permissionState = props.server && permission ? permission.ensureServerState(props.server) : undefined
    const permissionMembers = members.filter((member) => !!member.directory)
    const permissionReady = permissionState?.ready() ?? false
    const working = members.filter((member) => tabSessionState(ctx, member.id) === "working").length
    const stopEligible = members.filter((member) => {
      const state = tabSessionState(ctx, member.id)
      return state === "working" || state === "interrupted"
    }).length
    const paused = members.filter((member) => tabSessionState(ctx, member.id) === "paused").length
    const pokeable = members.filter((member) => {
      const status = tabSessionState(ctx, member.id)
      return !!member.directory && status === "idle"
    }).length
    return {
      members: members.length,
      permissionMembers: permissionMembers.length,
      permissionReady,
      working,
      stopEligible,
      paused,
      pokeable,
      allAutoAccepting:
        permissionReady &&
        permissionMembers.length > 0 &&
        permissionMembers.every((member) => permissionState?.isAutoAccepting(member.id, member.directory)),
      titlePending: groupTitlePending(),
    }
  })

  const currentVariant = createMemo(() => props.session?.model?.variant ?? undefined)
  // The session stores an account-qualified id ("deepseek-v4.1-flash@zen-889db3308123").
  // Show the catalog name plus the human account/key label instead of the raw internal
  // ids. Both lookups degrade gracefully: if the catalog or credential list hasn't loaded
  // yet we fall back to the base model id rather than the qualified one.
  const currentModelLabel = createMemo(() => {
    const model = props.session?.model
    if (!model?.id) return undefined
    const parts = splitMultiAccountModelID(model.id)
    const catalogName = providers.all().get(model.providerID)?.models[parts.baseModelID]?.name
    const name = catalogName ?? parts.baseModelID
    if (!parts.accountID) return name
    const account = forkUsage.credentials.latest?.find((credential) => credential.id === parts.accountID)
    const accountName = account?.label ?? (parts.accountID === forkUsage.activeCredentialID() ? forkUsage.activeCredentialLabel() : undefined)
    return accountName ? `${name} · ${accountShortLabel(accountName)}` : name
  })

  const owner = getOwner()
  let cachedPrompt: { key: string; value: PromptSession } | undefined
  const ensurePromptSession = async () => {
    const sid = sessionID()
    const sess = props.session
    const ctx = serverCtx()
    if (!sid || !sess || !ctx || !owner) return undefined
    const key = `${props.server ?? ""}\0${sid}\0${sess.directory}`
    if (cachedPrompt?.key === key) {
      await cachedPrompt.value.ready.promise
      return cachedPrompt.value
    }
    const { createPromptSession } = await loadPromptRuntime()
    const created = runWithOwner(owner, () =>
      createPromptSession(ctx.sdk.scope, { dir: base64Encode(sess.directory), id: sid }),
    )
    if (!created) return undefined
    cachedPrompt = { key, value: created }
    await created.ready.promise
    return created
  }

  const changeModel = () => {
    const group = props.isGroup ? groupMembers() : []
    const sess = props.isGroup ? group.find((member) => !!member.session?.directory)?.session : props.session
    const sid = sess?.id
    if (!sid || !sess) return
    // Capture synchronously — this is the pointerdown that selected "Change
    // model" itself, so the popover spawns right there, like a submenu flyout.
    const anchor = { top: lastPointerPosition.y, left: lastPointerPosition.x }
    const ctx = serverCtx()
    if (!ctx) return
    const modelMembers = group
      .filter((member) => member.id !== sid && !!member.directory)
      .map((member) => ({ id: member.id, directory: member.directory! }))
    const unavailableMembers = props.isGroup ? Math.max(0, group.length - modelMembers.length - 1) : 0
    const request: SessionModelPickerRequest = {
      session: sess,
      server: props.server,
      serverScope: ctx.sdk.scope,
      anchor,
      applyModelTo: props.isGroup ? modelMembers : undefined,
      onBulkModelApplied: props.isGroup
        ? (result) =>
            showGroupActionResult("sessionGroup.changeModelAll", {
              total: result.total + unavailableMembers + 1,
              succeeded: result.succeeded + 1,
              failed: result.failed + unavailableMembers,
            })
        : undefined,
    }
    if (props.onChangeModel) {
      props.onChangeModel(request)
      return
    }
    setModelPicker(request)
  }

  const selectVariant = (variant: string | undefined) => {
    void holdSurface(async () => {
      const ps = await ensurePromptSession()
      const m = ps?.model
      if (!m) return
      const current = m.current() ?? promptFromSession(props.session)
      if (!current) return
      m.set({ providerID: current.providerID, modelID: current.modelID, variant: variant ?? null })
      showToast({ title: language.t("command.model.variant.cycle"), variant: "success" })
    })
  }

  const toggleAutoAccept = () => {
    if (!permission) return
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess) return
    permission.toggleAutoAccept(sid, sess.directory)
    const active = permission.isAutoAccepting(sid, sess.directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const showGroupActionResult = (
    titleKey: string,
    result: { total: number; succeeded: number; failed: number },
  ) =>
    showToast({
      title: language.t(titleKey),
      description: language.t(
        result.failed > 0 ? "sessionGroup.action.partial" : "sessionGroup.action.success",
        result.failed > 0
          ? { succeeded: result.succeeded, count: result.total, failed: result.failed }
          : { count: result.succeeded },
      ),
      variant: result.failed > 0 ? "error" : "success",
    })

  const runGroupMenuAction = <T,>(
    titleKey: string,
    targets: T[],
    action: (target: T) => Promise<unknown>,
    concurrency = 4,
  ) => {
    if (targets.length === 0) return
    void holdSurface(async () => {
      const result = await runGroupAction(targets, action, concurrency)
      showGroupActionResult(titleKey, result)
    })
  }

  const stopAll = () => {
    const ctx = serverCtx()
    const current = api()
    if (!ctx || !current) return
    const targets = groupMembers().filter((member) => {
      const state = tabSessionState(ctx, member.id)
      return state === "working" || state === "interrupted"
    })
    runGroupMenuAction("sessionGroup.stopAll.done", targets, (member) => stopSession(current, member.id))
  }

  const pauseAll = () => {
    const ctx = serverCtx()
    const current = api()
    if (!ctx || !current) return
    const targets = groupMembers().filter((member) => tabSessionState(ctx, member.id) === "working")
    runGroupMenuAction("sessionGroup.pauseAll.done", targets, (member) => current.pause({ sessionID: member.id }))
  }

  const resumeAll = () => {
    const current = api()
    if (!current) return
    const targets = groupMembers().filter((member) => tabSessionState(serverCtx(), member.id) === "paused")
    runGroupMenuAction("sessionGroup.resumeAll.done", targets, (member) => current.resume({ sessionID: member.id }))
  }

  const regenerateGroupTitle = () => {
    const group = groupEntry()
    if (!group || group.kind === "swarm" || groupTitlePending()) return
    const title = generateSessionGroupTitle(
      group.sessions
        .filter((member) => member.time?.archived == null)
        .map((member) => member.title),
    )
    if (!title) {
      showToast({
        title: language.t("sessionGroup.regenerateGroupTitle.unavailable"),
        variant: "error",
      })
      return
    }
    if (title === group.name) {
      showToast({ title: language.t("sessionGroup.regenerateGroupTitle.current"), variant: "success" })
      return
    }
    setGroupTitlePending(true)
    void sessionGroups
      .renameGroup({ id: group.id, name: title })
      .then(() =>
        showToast({
          title: language.t("sessionGroup.regenerateGroupTitle.done"),
          description: title,
          variant: "success",
        }),
      )
      .catch((error: unknown) =>
        showToast({
          title: language.t("sessionGroup.regenerateGroupTitle.failed"),
          description: error instanceof Error ? error.message : undefined,
          variant: "error",
        }),
      )
      .finally(() => setGroupTitlePending(false))
  }

  const toggleAutoAcceptAll = () => {
    if (!props.server || !permission) return
    const permissionState = permission.ensureServerState(props.server)
    if (!permissionState.ready()) return
    const targets = groupMembers().filter((member) => !!member.directory)
    if (targets.length === 0) return
    const enable = !groupMenuState().allAutoAccepting
    for (const member of targets) {
      if (enable) permissionState.enableAutoAccept(member.id, member.directory!)
      else permissionState.disableAutoAccept(member.id, member.directory)
    }
    showToast({
      title: language.t(
        enable ? "toast.permissions.autoaccept.on.title" : "toast.permissions.autoaccept.off.title",
      ),
      description: language.t("sessionGroup.action.success", { count: targets.length }),
      variant: "success",
    })
  }

  type PokePromptInput = {
    sessionID: string
    id: string
    agent?: string
    model?: { providerID: string; modelID: string; variant?: string }
    text: string
    legacyParts?: Array<{ id: string; type: "text"; text: string }>
  }
  const poke = async () => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess || !props.server) return
    const conn = global.servers.list().find((c) => ServerConnection.key(c) === props.server)
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    // Human Poke is a continuation, not a model or agent reassignment. Let
    // the server bind the exact delegated route/account/variant from ownership.
    const delegated = sess.humanInterjection === true
    const model = delegated ? undefined : await holdSurface(async () => {
      const ps = await ensurePromptSession()
      return ps?.model.current() ?? promptFromSession(sess)
    })
    const messageID = Identifier.ascending("message")
    const input: PokePromptInput = {
      sessionID: sid,
      id: messageID,
      agent: delegated ? undefined : (sess.agent ?? "build"),
      model: model
        ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? undefined }
        : undefined,
      text: "continue",
      legacyParts: [{ id: `prt_${messageID}`, type: "text", text: "continue" }],
    }
    try {
      await (ctx.sdk.api.session as unknown as { prompt: (input: PokePromptInput) => Promise<unknown> }).prompt(input)
      showToast({ title: language.t("command.session.poke"), variant: "success" })
    } catch (err) {
      showToast({
        title: language.t("command.session.poke"),
        description: err instanceof Error ? err.message : undefined,
        variant: "error",
      })
    }
  }

  const pokeAll = () => {
    const ctx = serverCtx()
    if (!ctx) return
    const targets = groupMembers().filter(
      (member) => !!member.directory && tabSessionState(ctx, member.id) === "idle",
    )
    const sessionAPI = ctx.sdk.api.session as unknown as { prompt: (input: PokePromptInput) => Promise<unknown> }
    runGroupMenuAction(
      "sessionGroup.pokeAll.done",
      targets,
      async (member) => {
        const delegated = member.session?.humanInterjection === true
        let model: PromptModel | undefined
        if (!delegated) {
          const { createPromptSession } = await loadPromptRuntime()
          if (!owner || !member.directory) throw new Error("Session prompt is unavailable")
          const prompt = runWithOwner(owner, () =>
            createPromptSession(ctx.sdk.scope, { dir: base64Encode(member.directory!), id: member.id }),
          )
          if (!prompt) throw new Error("Session prompt is unavailable")
          await prompt.ready.promise
          model = prompt.model.current() ?? promptFromSession(member.session)
        }
        const messageID = Identifier.ascending("message")
        await sessionAPI.prompt({
          sessionID: member.id,
          id: messageID,
          agent: delegated ? undefined : (member.session?.agent ?? "build"),
          model: model
            ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? undefined }
            : undefined,
          text: "continue",
          legacyParts: [{ id: `prt_${messageID}`, type: "text", text: "continue" }],
        })
      },
    )
  }

  const compact = async () => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess || !props.server) return
    const conn = global.servers.list().find((c) => ServerConnection.key(c) === props.server)
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    const model = await holdSurface(async () => {
      const ps = await ensurePromptSession()
      return ps?.model.current() ?? promptFromSession(sess)
    })
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
        variant: "error",
      })
      return
    }
    try {
      await (
        ctx.sdk.api.session as unknown as {
          compact: (input: { sessionID: string; model: { providerID: string; modelID: string } }) => Promise<unknown>
        }
      ).compact({
        sessionID: sid,
        model: { providerID: model.providerID, modelID: model.modelID },
      })
      showToast({ title: language.t("command.session.compact"), variant: "success" })
    } catch (err) {
      showToast({
        title: language.t("command.session.compact"),
        description: err instanceof Error ? err.message : undefined,
        variant: "error",
      })
    }
  }

  const onCreateGroupDialog = () => {
    const sid = sessionID()
    if (!sid) return
    void loadGroupDialogRuntime().then(({ DialogSessionGroupName }) => {
      // If host provided onCreateGroup, use it via dialog that forwards name + sid.
      if (props.onCreateGroup) {
        dialog.show(() => <DialogSessionGroupName onSubmit={(name) => void props.onCreateGroup?.(name, [sid])} />)
        return
      }
      dialog.show(() => (
        <DialogSessionGroupName
          onSubmit={(name) =>
            void sessionGroups
              .createGroup(name)
              .then((g) => sessionGroups.addSessionToGroup({ groupId: g.id, sessionId: sid }))
          }
        />
      ))
    })
  }

  const sections = createMemo<MenuSectionDef[]>(() =>
    createSessionMenuModel({
      where: props.where,
      language,
      state: state(),
      pendingRegenerate: pendingRegenerate(),
      sessionID: sessionID(),
      isGroup: props.isGroup,
      tabIndex: tabIndex(),
      tabCount: tabCount(),
      userGroups: userGroups(),
      isInGroup: isInGroup(),
      membershipLocked: membershipLocked(),
      isAutoAccepting: isAutoAccepting(),
      isPinned: isPinned(),
      currentVariant: currentVariant(),
      currentModelLabel: currentModelLabel(),
      availableVariants: [...DEFAULT_VARIANTS],
      groupState: props.isGroup ? groupMenuState() : undefined,
      onCreateGroupDialog,
      actions: {
        open: props.onOpen ? () => props.onOpen?.({ background: false }) : undefined,
        openInBackground: props.onOpen ? () => props.onOpen?.({ background: true }) : undefined,
        stop,
        pause,
        resume,
        regenerateTitle,
        stopAll: props.isGroup && api() ? stopAll : undefined,
        pauseAll: props.isGroup && api() ? pauseAll : undefined,
        resumeAll: props.isGroup && api() ? resumeAll : undefined,
        regenerateGroupTitle:
          props.isGroup && groupEntry()?.kind !== "swarm" && groupEntry() ? regenerateGroupTitle : undefined,
        changeModelAll: props.isGroup && groupMembers().some((member) => !!member.session?.directory) ? changeModel : undefined,
        toggleAutoAcceptAll: props.isGroup && permission ? toggleAutoAcceptAll : undefined,
        pokeAll: props.isGroup && serverCtx() ? pokeAll : undefined,
        renameGroup:
          props.isGroup && groupEntry()?.kind !== "swarm" && groupEntry() ? renameGroup : undefined,
        addSessions: props.isGroup && props.where === "group-tab" ? addSessions : undefined,
        addToGroup: (groupId) => {
          if (props.onAddToGroup) {
            props.onAddToGroup(groupId)
            return
          }
          const sid = sessionID()
          if (!sid) return
          void sessionGroups.addSessionToGroup({ groupId, sessionId: sid })
        },
        removeFromGroup: () => {
          if (props.onRemoveFromGroup) {
            props.onRemoveFromGroup()
            return
          }
          const sid = sessionID()
          const gid = props.inGroupId
          if (!sid || !gid) return
          void sessionGroups.removeSessionFromGroup({ groupId: gid, sessionId: sid })
        },
        archive: props.onArchive ? () => void props.onArchive?.() : undefined,
        close: props.tabId ? close : undefined,
        closeLeft: props.tabId ? closeLeft : undefined,
        closeRight: props.tabId ? closeRight : undefined,
        closeOthers: props.tabId ? closeOthers : undefined,
        closeAll: props.tabId ? closeAll : undefined,
        changeModel,
        selectVariant,
        toggleAutoAccept,
        poke,
        compact,
        exportJson,
        copySessionId,
        renameSession,
        togglePin,
        newSessionInProject: props.onNewSessionInProject,
        openProjectInExplorer: props.onOpenProjectInExplorer,
        copyProjectPath: props.onCopyProjectPath,
        changeProject: changeProject(),
        forkConversation: props.onForkConversation,
      },
    }),
  )

  return (
    <>
      <Show
        when={props.cursor}
        keyed
        fallback={
          <MenuV2.Context onOpenChange={setContextOpen}>
            <MenuV2.Context.Trigger
              class="block h-full w-full min-w-0"
              as="div"
              data-model-picker-open={modelPicker() ? "" : undefined}
            >
              {props.children}
            </MenuV2.Context.Trigger>
            <MenuV2.Context.Portal>
              <MenuV2.Context.Content>
                <MenuSectionsRenderer sections={sections()} />
              </MenuV2.Context.Content>
            </MenuV2.Context.Portal>
          </MenuV2.Context>
        }
      >
        {(cursor) => (
          <MenuV2
            open={contextOpen()}
            onOpenChange={setContextOpen}
            placement="right-start"
            gutter={2}
            shift={2}
            flip
            overflowPadding={8}
          >
            <ContextMenuCursorTrigger x={cursor.x} y={cursor.y} />
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuSectionsRenderer sections={sections()} />
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        )}
      </Show>
      <Show when={modelPicker()} keyed>
        {(state) => (
          <Suspense>
            <SessionModelPicker {...state} onClose={() => setModelPicker(null)} />
          </Suspense>
        )}
      </Show>
    </>
  )
}
