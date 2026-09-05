import { createMemo, createSignal, getOwner, onCleanup, runWithOwner, Show, type ParentProps } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { useTabs, tabKey } from "@/context/tabs"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { useSessionGroups } from "@/context/session-groups"
import { DialogSessionGroupName, DialogSessionGroupPicker } from "../dialog-session-group"
import { showToast } from "@/utils/toast"
import { tabSessionState } from "../titlebar-tab-state"
import {
  isTitleRegenerationPending,
  sessionApiOf,
  beginTitleRegeneration,
  endTitleRegeneration,
} from "../titlebar-tab-actions"
import { createSessionMenuModel, type SessionMenuWhere } from "./session-menu-model"
import type { MenuSectionDef } from "./menu-model"
import { MenuSectionsRenderer } from "./menu-renderer"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useLocal } from "@/context/local"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Identifier } from "@/utils/id"
import { createPromptSession, type PromptModel, type PromptSession } from "@/context/prompt-state"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { ModelsProvider } from "@/context/models"
import { SDKProvider } from "@/context/sdk"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useDirectoryPicker } from "@/components/directory-picker"
import { getProjectAvatarVariant } from "@/context/layout"
import { pathKey } from "@/utils/path-key"
import { chatsRoot } from "@opencode-ai/core/project/chat-paths"
import { isSessionPinned, toggleSessionPin } from "@/utils/pinned-sessions"
import { fetchSessionExport, sessionExportFilename, downloadSessionExport } from "@/utils/session-export"
import type { ServerScope } from "@/utils/server-scope"

const promptFromSession = (sess: Session | undefined): PromptModel | undefined => {
  const model = sess?.model
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.id, variant: model.variant }
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

export type SessionModelPickerRequest = {
  session: Session
  server?: ServerConnection.Key
  serverScope: ServerScope
  anchor: { top: number; left: number }
}

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

  const sessionID = createMemo(() => props.session?.id)
  const serverCtx = createMemo(() => {
    if (!props.server) return undefined
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })

  const state = createMemo(() => tabSessionState(serverCtx(), sessionID()))
  const pendingRegenerate = createMemo(() => isTitleRegenerationPending(sessionID()))

  const tabIndex = createMemo(() => {
    if (!props.tabId) return -1
    return tabs.store.findIndex((item) => tabKey(item) === props.tabId)
  })
  const tabCount = createMemo(() => tabs.store.length)

  const userGroups = () => sessionGroups.groups().map((g) => ({ id: g.id, name: g.name }))
  const isInGroup = createMemo(() => !!props.inGroupId)
  const membershipLocked = createMemo(() => {
    const groupID = props.inGroupId
    const sid = sessionID()
    if (!groupID || !sid) return false
    return sessionGroups.byID(groupID)?.sessions.find((member) => member.id === sid)?.locked ?? false
  })

  // Default control actions (stop/pause/resume/regenerate) — hosts may override via props actions
  const api = createMemo(() => sessionApiOf(serverCtx()))

  const stop = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void (a as unknown as { interrupt: (p: { sessionID: string }) => Promise<unknown> }).interrupt({ sessionID: id })
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
  const regenerateTitle = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a || pendingRegenerate()) return
    beginTitleRegeneration(id)
    void a
      .regenerateTitle({ sessionID: id })
      .then(() => showToast({ title: language.t("toast.title.regenerated"), variant: "success" }))
      .catch((err) =>
        showToast({
          title: language.t("toast.title.failed"),
          description: err instanceof Error ? err.message : undefined,
          variant: "error",
        }),
      )
      .finally(() => endTitleRegeneration(id))
  }

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
    void dialog.show(() => (
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
    ))
  }

  const exportJson = () => {
    const sid = sessionID()
    const ctx = serverCtx()
    if (!sid || !ctx) return
    void fetchSessionExport({ sessionID: sid, client: ctx.sdk.client })
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
      })
  }

  const changeProject = createMemo(() => {
    const sess = props.session
    const ctx = serverCtx()
    if (!sess || !ctx) return undefined
    const current = pathKey(sess.directory)
    const moveSessionTo = (worktree: string) => {
      const sid = sessionID()
      if (!sid || pathKey(worktree) === pathKey(sess.directory)) return
      void ctx.sdk.client.experimental.controlPlane
        .moveSession({ sessionID: sid, destination: { directory: worktree }, moveChanges: false })
        .then(() => showToast({ title: language.t("toast.session.move.success.title"), variant: "success" }))
        .catch((err: unknown) => {
          showToast({
            title: language.t("toast.session.move.failed.title"),
            description: err instanceof Error ? err.message : undefined,
            variant: "error",
          })
        })
    };
    // Same options as the new-session project selector: the chats entry plus
    // this server's known projects. Selecting one re-associates the session
    // with that project without transferring uncommitted changes.
    const projects = (
      [{ name: "Chat", id: "chats", worktree: chatsRoot(), sandboxes: [] as string[] }, ...ctx.projects.list()] as Array<{
        worktree: string
        name?: string
        id?: string
        icon?: { color?: string; url?: string; override?: string }
        sandboxes?: string[]
      }>
    ).map((project) => {
      const label = displayName(project)
      return {
        worktree: project.worktree,
        label,
        current:
          pathKey(project.worktree) === current ||
          project.sandboxes?.some((sandbox) => pathKey(sandbox) === current) === true,
        disabled: pathKey(project.worktree) === current,
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
    void dialog.show(() => (
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
    ))
  }
  const addSessions = () => {
    const sid = sessionID()
    const current = props.groupId
    if (!sid || !current) return
    const choices = sessionGroups.groups().filter((group) => group.id !== current && group.kind === "user")
    void dialog.show(() => (
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
    ))
  }

  // These contexts are available at different levels in the provider tree:
  // - PermissionProvider is at the App root (TabsProvider -> PermissionProvider), so it's available in titlebar/home/chats.
  // - LocalProvider is only inside DirectoryLayout / SessionRoute (per-directory), so titlebar (NewAppLayout) is *outside* it and useLocal() would throw.
  // - PromptProvider is also route-scoped. We already avoid it via createPromptSession.
  // Make them optional so the menu still renders (with those sections disabled/hidden) even when the provider is missing.
  let permission: ReturnType<typeof usePermission> | undefined
  try {
    permission = usePermission()
  } catch {
    permission = undefined
  }
  let local: ReturnType<typeof useLocal> | undefined
  try {
    local = useLocal()
  } catch {
    local = undefined
  }

  const [modelPicker, setModelPicker] = createSignal<{
    session: Session
    server?: ServerConnection.Key
    promptModel: PromptSession["model"]
    anchor: { top: number; left: number }
  } | null>(null)

  const isAutoAccepting = createMemo(() => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess || !permission) return false
    return permission.isAutoAccepting(sid, sess.directory)
  })

  const currentVariant = createMemo(() => props.session?.model?.variant ?? undefined)
  const currentModelLabel = createMemo(() => props.session?.model?.id)
  const availableVariants = createMemo(() => {
    if (!local) return ["default", "low", "medium", "high", "xhigh"]
    try {
      const list = local.model.variant.list()
      return list.length > 0 ? ["default", ...list] : ["default", "low", "medium", "high", "xhigh"]
    } catch {
      return ["default", "low", "medium", "high", "xhigh"]
    }
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
    const created = runWithOwner(owner, () =>
      createPromptSession(ctx.sdk.scope, { dir: base64Encode(sess.directory), id: sid }),
    )
    if (!created) return undefined
    cachedPrompt = { key, value: created }
    await created.ready.promise
    return created
  }

  const promptFromLocal = (): PromptModel | undefined => {
    const item = local?.model.current()
    if (!item) return undefined
    return { providerID: item.provider.id, modelID: item.id }
  }

  const changeModel = () => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess) return
    // Capture synchronously — this is the pointerdown that selected "Change
    // model" itself, so the popover spawns right there, like a submenu flyout.
    const anchor = { top: lastPointerPosition.y, left: lastPointerPosition.x }
    if (props.onChangeModel) {
      const ctx = serverCtx()
      if (!ctx) return
      props.onChangeModel({ session: sess, server: props.server, serverScope: ctx.sdk.scope, anchor })
      return
    }
    void ensurePromptSession().then((ps) => {
      const model = ps?.model
      if (!model) return
      // Same picker the composer footer uses (ModelSelectorPopoverV2), always —
      // NOT the full "Select model" dialog (DialogSelectModel). Opened via an
      // invisible auto-clicked trigger anchored where "Change model" was
      // clicked, since this action has no visible trigger of its own.
      // Tabs/home/chats live *outside* the routed DirectoryLayout, so
      // useLocal()/useSDK() (which ModelSelectorPopoverV2 needs) aren't
      // ambiently available there — SessionModelPopoverHost mounts a
      // directory-scoped provider subtree on demand when that's the case.
      setModelPicker({
        session: sess,
        server: props.server,
        promptModel: model,
        anchor,
      })
    })
  }

  const selectVariant = (variant: string | undefined) => {
    void ensurePromptSession().then((ps) => {
      const m = ps?.model
      if (!m) return
      const current = m.current() ?? promptFromSession(props.session) ?? promptFromLocal()
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

  type PokePromptInput = {
    sessionID: string
    id: string
    agent: string
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
    const ps = await ensurePromptSession()
    const model = ps?.model.current() ?? promptFromSession(sess) ?? promptFromLocal()
    const agent = local?.agent.current()
    const messageID = Identifier.ascending("message")
    const input: PokePromptInput = {
      sessionID: sid,
      id: messageID,
      agent: agent?.name ?? "build",
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

  const compact = async () => {
    const sid = sessionID()
    const sess = props.session
    if (!sid || !sess || !props.server) return
    const conn = global.servers.list().find((c) => ServerConnection.key(c) === props.server)
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    const ps = await ensurePromptSession()
    const model = ps?.model.current() ?? promptFromSession(sess) ?? promptFromLocal()
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
    // If host provided onCreateGroup, use it via dialog that forwards name + sid
    if (props.onCreateGroup) {
      void dialog.show(() => <DialogSessionGroupName onSubmit={(name) => void props.onCreateGroup?.(name, [sid])} />)
      return
    }
    void dialog.show(() => (
      <DialogSessionGroupName
        onSubmit={(name) =>
          void sessionGroups
            .createGroup(name)
            .then((g) => sessionGroups.addSessionToGroup({ groupId: g.id, sessionId: sid }))
        }
      />
    ))
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
      availableVariants: availableVariants(),
      onCreateGroupDialog,
      actions: {
        open: props.onOpen ? () => props.onOpen?.({ background: false }) : undefined,
        openInBackground: props.onOpen ? () => props.onOpen?.({ background: true }) : undefined,
        stop,
        pause,
        resume,
        regenerateTitle,
        renameGroup: props.isGroup ? renameGroup : undefined,
        addSessions: props.isGroup ? addSessions : undefined,
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
      <MenuV2.Context>
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
      <Show when={modelPicker()} keyed>
        {(state) => (
          <SessionModelPopoverHost
            session={state.session}
            server={state.server}
            promptModel={state.promptModel}
            anchor={state.anchor}
            onClose={() => setModelPicker(null)}
          />
        )}
      </Show>
    </>
  )
}

/**
 * Resolves the picker's model context: reuse the ambient LocalProvider when
 * this menu instance already lives inside one (the tab for the currently
 * open directory), otherwise mount a self-contained directory+server-scoped
 * provider subtree (same pattern as app.tsx's ResolvedDraftRoute) so
 * useLocal()/useSDK() work for a session in a *different* or no-longer-routed
 * directory (titlebar tabs, home, chats).
 */
function SessionModelPopoverHost(props: {
  session: Session
  server?: ServerConnection.Key
  promptModel: PromptSession["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  let ambientLocal: ReturnType<typeof useLocal> | undefined
  try {
    ambientLocal = useLocal()
  } catch {
    ambientLocal = undefined
  }

  if (ambientLocal) {
    return (
      <ModelWrapperPopover
        session={props.session}
        promptModel={props.promptModel}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    )
  }

  return (
    <ScopedLocalProvider session={props.session} server={props.server}>
      <ModelWrapperPopover
        session={props.session}
        promptModel={props.promptModel}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    </ScopedLocalProvider>
  )
}

/**
 * Stable host for menus rendered inside volatile row wrappers (for example a
 * TooltipV2). Prompt state and providers are created only while the picker is
 * open, under this host's owner rather than the row that issued the request.
 */
export function SessionModelPicker(props: SessionModelPickerRequest & { onClose: () => void }) {
  const prompt = createPromptSession(props.serverScope, {
    dir: base64Encode(props.session.directory),
    id: props.session.id,
  })
  const [ready, setReady] = createSignal(prompt.ready())
  let disposed = false

  if (!ready()) {
    void Promise.resolve(prompt.ready.promise)
      .then(() => {
        if (!disposed) setReady(true)
      })
      .catch(() => {
        if (!disposed) props.onClose()
      })
  }
  onCleanup(() => {
    disposed = true
  })

  return (
    <Show when={ready()}>
      <SessionModelPopoverHost
        session={props.session}
        server={props.server}
        promptModel={prompt.model}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    </Show>
  )
}

function ScopedLocalProvider(props: ParentProps<{ session: Session; server?: ServerConnection.Key }>) {
  const global = useGlobal()
  const conn = createMemo(() =>
    props.server ? global.servers.list().find((item) => ServerConnection.key(item) === props.server) : undefined,
  )
  const directory = () => props.session.directory
  const server = () => props.server

  return (
    <ServerSDKProvider server={conn}>
      <ServerSyncProvider server={conn}>
        <ModelsProvider directory={directory}>
          <SDKProvider directory={directory}>
            <DirectoryDataProvider directory={directory} server={server}>
              {props.children}
            </DirectoryDataProvider>
          </SDKProvider>
        </ModelsProvider>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

/**
 * Wraps the session's PromptSession model as a ModelState (the shape
 * ModelSelectorPopoverV2 expects), reads/writes always target *this*
 * session's model — never the ambient LocalProvider's own current
 * session/directory (which may be unrelated when scoped by ScopedLocalProvider,
 * or even when reused ambiently: the ambient LocalProvider's `current()` is
 * keyed by the routed session id, not necessarily this row's session).
 */
function ModelWrapperPopover(props: {
  session: Session
  promptModel: PromptSession["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  const local = useLocal()
  const localModel = local.model
  const wrapper = {
    ...localModel,
    current: () => {
      const selected = props.promptModel.current() ?? promptFromSession(props.session)
      if (!selected) return localModel.current()
      return (
        localModel.list().find((item) => item.provider.id === selected.providerID && item.id === selected.modelID) ??
        localModel.current()
      )
    },
    set: (
      value: { providerID: string; modelID: string; variant?: string } | undefined,
      opts?: { recent?: boolean },
    ) => {
      props.promptModel.set(value)
      localModel.set(value, opts)
    },
  }

  return <SessionModelPopover model={wrapper} anchor={props.anchor} onClose={props.onClose} />
}

/**
 * Mounts the exact composer-footer picker (ModelSelectorPopoverV2 from
 * dialog-select-model.tsx) via an invisible, auto-clicked trigger — the
 * context menu action has no persistent visible trigger button of its own.
 */
function SessionModelPopover(props: {
  model: ReturnType<typeof useLocal>["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  const [Comp, setComp] = createSignal<typeof import("@/components/dialog-select-model").ModelSelectorPopoverV2>()
  void import("@/components/dialog-select-model").then((mod) => setComp(() => mod.ModelSelectorPopoverV2))

  return (
    <Show when={Comp()} keyed>
      {(C) => {
        return (
          <C
            model={props.model}
            defaultOpen
            onClose={props.onClose}
            trigger={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                ref={(el: HTMLButtonElement) => {
                  const forwardRef = (triggerProps as { ref?: (el: HTMLButtonElement) => void }).ref
                  if (typeof forwardRef === "function") forwardRef(el)
                }}
                style={{
                  position: "fixed",
                  top: `${props.anchor.top}px`,
                  left: `${props.anchor.left}px`,
                  width: "1px",
                  height: "1px",
                  opacity: 0,
                  "pointer-events": "none",
                }}
                tabIndex={-1}
                aria-hidden="true"
              />
            )}
          />
        )
      }}
    </Show>
  )
}
