import { createRenderEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { MenuSectionDef } from "./menu-model"

/**
 * Preserve the identity of mounted menu rows when their presentation model changes.
 *
 * Session status, membership and tab state can update while the menu is open.
 * A plain <For> keyed by each newly allocated model object would dispose every
 * item (and Kobalte's roving-focus ownership) on each such update.
 *
 * Solid Store reconciliation matches sections and their nested items by their
 * domain-owned ids while updating the live labels, enabled state and handlers.
 * This work is confined to a mounted menu, never to each session-list row.
 *
 * IDs must be unique within each sibling array; dynamic sections may freely
 * appear, disappear or move without requiring stable indices.
 */
export function createReconciledMenuSections(source: Accessor<MenuSectionDef[]>): MenuSectionDef[] {
  const [sections, setSections] = createStore<MenuSectionDef[]>([])
  // Run before paint, including initial creation, so the first open cannot
  // briefly render an empty menu before a deferred effect hydrates its rows.
  createRenderEffect(() => setSections(reconcile(source(), { key: "id" })))
  return sections
}
