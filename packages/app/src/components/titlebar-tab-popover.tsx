import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useSessionGroups } from "@/context/session-groups"
import { useServer } from "@/context/server"
import { previewGroupScopeMatches } from "@/context/session-group-preview-index"
import { useTabs, tabKey } from "@/context/tabs"
import { displayName, projectForSessionIndexed } from "@/pages/layout/helpers"
import { SessionPreviewCard } from "@/components/session-preview/session-preview-card"
import type { SessionPreviewRelationships } from "@/components/session-preview/session-preview-model"
import { sessionPreviewProjectionCache } from "@/components/session-preview/session-preview-cache"
import type { TabPreviewIntent } from "./titlebar-tab-preview-controller"
import "./titlebar-tab-popover.css"

/**
 * One mounted SessionPreviewCard and one Portal for the entire tab strip.
 * The pointer controller switches intent; no hover-card providers or wrapper
 * elements are ever installed around individual tab links/actions.
 */
export function TabPreviewPopover(props: {
  intent: () => TabPreviewIntent | undefined
  onContentEnter: () => void
  onContentLeave: () => void
  onContextMenuOpenChange: (open: boolean) => void
  onClose: () => void
}) {
  const sessionGroups = useSessionGroups()
  const selectedServer = useServer()
  const tabs = useTabs()
  const intent = props.intent
  const previewActive = createMemo(() => !!intent())
  const tab = () => intent()?.tab
  // Memoizing the *scope keys*, not the whole hover intent, prevents remote
  // snapshot/observer churn while moving between tabs on the same server.
  const server = createMemo(() => tab()?.server)
  const serverCtx = () => intent()?.serverCtx()
  const sessionID = createMemo(() => {
    const value = tab()
    return value?.type === "session" ? value.sessionId : undefined
  })
  const groupID = createMemo(() => {
    const value = tab()
    return value?.type === "group" ? value.groupId : undefined
  })
  const previewKey = () => {
    const value = tab()
    return value ? [value.server, value.type, value.type === "session" ? value.sessionId : value.groupId].join(":") : undefined
  }
  const groupScopeMatches = createMemo(() => previewGroupScopeMatches(server(), selectedServer.key))
  const activeSelectedServer = createMemo(() => previewActive() && groupScopeMatches())
  createEffect(() => {
    if (activeSelectedServer()) sessionGroups.activateUrgent()
  })
  const remoteGroups = createMemo(() => {
    const key = server()
    if (!previewActive() || groupScopeMatches() || !key) return
    return sessionGroups.remotePreview(key)
  })
  createEffect(() => {
    const key = server()
    if (!previewActive() || groupScopeMatches() || !key) return
    onCleanup(sessionGroups.observeRemotePreview(key))
  })
  const index = createMemo(() => {
    if (!sessionID()) return
    if (groupScopeMatches()) return sessionGroups.previewIndex()
    const groups = remoteGroups()
    return groups ? sessionGroups.remotePreviewIndex(groups) : undefined
  })
  const selectedGroup = createMemo(() => {
    const id = groupID()
    if (!id) return
    return groupScopeMatches()
      ? sessionGroups.byID(id)
      : remoteGroups()?.find((value) => value.id === id)
  })
  const relationships = createMemo<SessionPreviewRelationships | undefined>(() => {
    if (!intent()) return
    const id = sessionID()
    if (id) {
      const groups = groupScopeMatches() ? sessionGroups.list() : remoteGroups()
      const idx = index()
      if (!groups || !idx) return
      return sessionPreviewProjectionCache.session({ sessionID: id, groups, index: idx })
    }
    const group = selectedGroup()
    return group ? { sections: [sessionPreviewProjectionCache.group(group)], specialAgents: [] } : undefined
  })
  const data = createMemo(() => {
    const value = tab()
    if (!value) return {}
    if (value.type === "group") {
      return { title: selectedGroup()?.name ?? tabs.info[tabKey(value)]?.title }
    }
    const ctx = serverCtx()
    const session = ctx?.sync.session.peek(value.sessionId)
    const project = session && projectForSessionIndexed(session, ctx?.projects.index())
    const home = ctx?.sync.data.path.home
    return {
      title: session?.title ?? tabs.info[tabKey(value)]?.title,
      directory: session?.directory,
      project,
      projectName: session ? displayName(project ?? { worktree: session.directory }) : undefined,
      path: session ? (home ? session.directory.replace(home, "~") : session.directory) : undefined,
      serverName: intent()?.serverLabel(),
    }
  })

  let contentEl: HTMLDivElement | undefined
  let positionFrame = 0
  const [position, setPosition] = createSignal<{ x: number; y: number }>()
  const updatePosition = () => {
    const current = intent()
    if (!current || !current.anchor.isConnected) {
      if (current) props.onClose()
      return
    }
    const rect = current.anchor.getBoundingClientRect()
    const size = contentEl?.getBoundingClientRect()
    const width = size?.width || 320
    const height = size?.height || 160
    const margin = 8
    const x = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))
    let y = rect.bottom + 6
    if (y + height > window.innerHeight - margin) y = rect.top - height - 6
    y = Math.max(margin, Math.min(y, window.innerHeight - height - margin))
    const next = { x: Math.round(x), y: Math.round(y) }
    const previous = position()
    if (previous?.x === next.x && previous.y === next.y) return
    setPosition(next)
  }
  const queuePosition = () => {
    if (positionFrame) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0
      updatePosition()
    })
  }
  createEffect(() => {
    const current = intent()
    if (!current) {
      setPosition(undefined)
      return
    }
    // The same DOM node is repositioned on a new tab, never re-created.
    const theme = current.anchor.closest("[data-theme]")?.getAttribute("data-theme")
    if (contentEl && theme) contentEl.setAttribute("data-theme", theme)
    setPosition(undefined)
    queuePosition()
  })
  // Dormant previews retain one card/virtualizer without retaining global
  // geometry listeners. A boolean memo also avoids listener churn when the
  // inspector is repopulated while moving rapidly between neighboring tabs.
  createEffect(() => {
    if (!previewActive()) return
    const onGeometryChange = () => queuePosition()
    window.addEventListener("resize", onGeometryChange, { passive: true })
    window.addEventListener("scroll", onGeometryChange, { capture: true, passive: true })
    onCleanup(() => {
      window.removeEventListener("resize", onGeometryChange)
      window.removeEventListener("scroll", onGeometryChange, true)
    })
  })
  onCleanup(() => {
    if (positionFrame) cancelAnimationFrame(positionFrame)
  })

  return (
    <Portal>
        <div
          ref={(el) => {
            contentEl = el
            const theme = intent()?.anchor.closest("[data-theme]")?.getAttribute("data-theme")
            if (theme) el.setAttribute("data-theme", theme)
            queuePosition()
          }}
          data-component="session-tab-popover"
          data-interactive
          style={{
            display: intent() ? "block" : "none",
            position: "fixed",
            left: `${position()?.x ?? 0}px`,
            top: `${position()?.y ?? 0}px`,
            visibility: position() ? "visible" : "hidden",
            "max-height": "calc(100vh - 16px)",
            "max-width": "calc(100vw - 16px)",
          }}
          onPointerEnter={props.onContentEnter}
          onPointerLeave={props.onContentLeave}
        >
          <SessionPreviewCard
            data={data()}
            relationships={relationships}
            currentSessionID={sessionID()}
            previewKey={previewKey()}
            server={server()}
            serverCtx={serverCtx}
            active={() => !!intent()}
            onOpenSession={props.onClose}
            onRowContextMenuOpenChange={props.onContextMenuOpenChange}
          />
        </div>
    </Portal>
  )
}
