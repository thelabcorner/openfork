import { HoverCard as Kobalte } from "@kobalte/core/hover-card"
import { createMemo, createSignal, type JSXElement } from "solid-js"
import type { ServerCtx } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { useSessionGroups } from "@/context/session-groups"
import { SessionPreviewCard, type SessionPreviewData } from "@/components/session-preview/session-preview-card"
import {
  buildSessionPreviewIndex,
  sessionPreviewGroupOnly,
  sessionPreviewRelationships,
  type SessionPreviewRelationships,
} from "@/components/session-preview/session-preview-model"
import "./titlebar-tab-popover.css"

// Initial hover delay before the preview appears, per design.
const OPEN_DELAY = 450
// Interactive previews need enough grace to cross the small trigger/content
// gutter without feeling sticky after the pointer genuinely leaves.
const CLOSE_DELAY = 140
// After a preview closes, hovering a neighbouring tab within this window skips
// the open delay — mirrors the tooltip's skipDelayDuration so moving across
// tabs doesn't re-wait the full delay each time.
const SKIP_WINDOW = 500
let lastClosedAt = 0

export type TabPreviewData = SessionPreviewData

/**
 * Kobalte HoverCard adapter around the canonical `SessionPreviewCard`.
 *
 * This component owns only positioning/animation/open-close choreography
 * (skip-window, warm streak, context-menu-open blocking a premature close).
 * All relationship classification and presentation live in the shared
 * `session-preview-model`/`SessionPreviewCard` used by both the titlebar and
 * the Chat Sidebar's pooled hover controller.
 *
 * The SessionGroup snapshot this reads is the same reactive query the Chat
 * Sidebar uses; because this component itself is lazy-imported and only
 * mounted after the tab's hover-delay bootstrap fires, opening it is the
 * first moment that query activates for the titlebar surface.
 */
export function TabPreviewPopover(props: {
  trigger: JSXElement
  open: boolean
  onOpenChange: (open: boolean) => void
  data: TabPreviewData
  server?: ServerConnection.Key
  serverCtx?: () => ServerCtx | undefined
  currentSessionID?: string
  /** Group tabs describe a SessionGroup directly instead of one Session's memberships. */
  groupID?: string
}) {
  const sessionGroups = useSessionGroups()
  let triggerEl: HTMLDivElement | undefined
  let contentEl: HTMLDivElement | undefined

  // When opened during a rapid tab-hopping streak, this preview appears and
  // disappears instantly (no repeated enter/exit animation) — only the first,
  // "cold" preview animates. Mirrors how browsers reuse one tab tooltip.
  const [instant, setInstant] = createSignal(false)
  const [contextMenuOpen, setContextMenuOpen] = createSignal(false)

  const index = createMemo(() => buildSessionPreviewIndex(sessionGroups.list()))
  const relationships = createMemo<SessionPreviewRelationships | undefined>(() => {
    if (props.currentSessionID) {
      return sessionPreviewRelationships({
        sessionID: props.currentSessionID,
        groups: sessionGroups.list(),
        index: index(),
      })
    }
    if (props.groupID) {
      const group = sessionGroups.byID(props.groupID)
      return group ? { sections: [sessionPreviewGroupOnly(group)], specialAgents: [] } : undefined
    }
    return undefined
  })
  // Mouse-interactable (pointer-events + Kobalte's safe-area cursor bridge)
  // whenever there is a server to navigate against — NOT gated on whether
  // relationships exist. A standalone session's preview is header-only but
  // still needs the safe-area bridge, or the pointer leaving the trigger for
  // the small trigger/content gutter reads as "left the hover zone" and
  // Kobalte closes it before the cursor ever reaches the card.
  const interactive = createMemo(() => !!props.server)

  // ---- Open/close lifecycle ---------------------------------------------
  const warm = () => Date.now() - lastClosedAt < SKIP_WINDOW
  // Kobalte reads openDelay lazily when the pointer enters the trigger, so this
  // resolves the skip window per-hover.
  const resolveOpenDelay = () => (warm() ? 0 : OPEN_DELAY)
  const handleOpenChange = (open: boolean) => {
    // A context menu is portalled outside the hover-card subtree. Keep this
    // owner mounted while that menu is open or moving the pointer into the menu
    // would dispose the row (and therefore the menu) underneath the user.
    if (!open && contextMenuOpen()) return
    if (open) setInstant(warm())
    else lastClosedAt = Date.now()
    props.onOpenChange(open)
  }

  const handleContextMenuOpenChange = (open: boolean) => {
    setContextMenuOpen(open)
    if (open) {
      props.onOpenChange(true)
      return
    }
    // If the pointer returned to the preview while the menu was open, let the
    // normal hover lifecycle retain it. Otherwise close immediately after the
    // menu is dismissed instead of leaving an orphaned preview on screen.
    requestAnimationFrame(() => {
      if (triggerEl?.matches(":hover") || contentEl?.matches(":hover")) return
      lastClosedAt = Date.now()
      props.onOpenChange(false)
    })
  }

  return (
    <Kobalte
      open={props.open}
      onOpenChange={handleOpenChange}
      openDelay={resolveOpenDelay()}
      closeDelay={CLOSE_DELAY}
      // Decorative previews can disappear as soon as the trigger is left.
      // Interactive previews are, so preserve Kobalte's safe-area bridge
      // between the tab and the portalled card.
      ignoreSafeArea={!interactive()}
      placement="bottom-start"
      gutter={6}
    >
      <Kobalte.Trigger ref={triggerEl} as="div" data-component="session-tab-popover-trigger" tabIndex={-1}>
        {props.trigger}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          ref={(el) => {
            contentEl = el
            // Portalled content lives outside the themed subtree, so mirror the
            // active theme like the v2 tooltip does.
            const theme = triggerEl?.closest("[data-theme]")?.getAttribute("data-theme")
            if (theme) el.setAttribute("data-theme", theme)
          }}
          data-component="session-tab-popover"
          data-interactive={interactive() || undefined}
          data-instant={instant() || undefined}
        >
          <SessionPreviewCard
            data={props.data}
            relationships={relationships}
            currentSessionID={props.currentSessionID}
            server={props.server}
            serverCtx={props.serverCtx}
            active={() => props.open}
            onOpenSession={() => props.onOpenChange(false)}
            onRowContextMenuOpenChange={handleContextMenuOpenChange}
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
