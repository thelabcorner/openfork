import { lazy, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { captureContextMenuSelection, type ContextMenuSelectionSnapshot } from "./context-menu-selection"
import { contextMenuPosition } from "./context-menu-position"

const GenericContextMenuContent = lazy(() =>
  import("./generic-context-menu-content").then((m) => ({ default: m.GenericContextMenuContent })),
)

/**
 * Lightweight app-wide right-click boundary. The actual Kobalte/MenuV2 graph
 * is demand-loaded on the first unclaimed context-menu event, so a feature
 * that users may never invoke cannot delay desktop startup.
 */
export function GenericContextMenuProvider(props: ParentProps) {
  const [state, setState] = createStore<{
    open: boolean
    request?: { x: number; y: number; selection: ContextMenuSelectionSnapshot }
  }>({ open: false })

  const handleContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const targetEl = event.target as Element | null
    if (targetEl?.closest('[data-component="menu-v2-content"]')) return
    const selection = captureContextMenuSelection(targetEl)
    event.preventDefault()
    const cursor = contextMenuPosition(
      event,
      targetEl ?? (event.currentTarget instanceof Element ? event.currentTarget : document.documentElement),
    )
    setState({ open: true, request: { ...cursor, selection } })
  }

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{ display: "contents" }}
    >
      {props.children}
      <Show when={state.open && state.request} keyed>
        {(request) => (
          <Suspense>
            <GenericContextMenuContent
              request={request}
              open={state.open}
              onOpenChange={(open) => setState("open", open)}
            />
          </Suspense>
        )}
      </Show>
    </div>
  )
}
