/**
 * The provider rail's persisted order, shared by the desktop selector and the
 * PWA so the two agree on both the storage key and the ordering rule.
 *
 * The rail is the vertical strip of provider icons on the left of the model
 * selector. Its order is user-defined (drag to reorder on desktop) and stored
 * as one more section in the model store's `order` record, under the same
 * `section:provider:<name>` namespace the per-group orders use — `rail` is a
 * reserved section name, and provider ids are user-defined slugs, hence the
 * prefix that keeps the two collision-free.
 */

import { applySectionOrder } from "./order"

/** Section name the provider rail's own order is stored under. */
export const PROVIDER_RAIL_SECTION = "rail"

/** Section name the favorites group's order is stored under. */
export const FAVORITES_SECTION = "favorites"

/**
 * Storage key for one selector section inside the `order` record. Mirrors the
 * desktop model store exactly; changing it orphans every persisted order.
 */
export function sectionStorageKey(section: string): string {
  return section === FAVORITES_SECTION ? "section:favorites" : `section:provider:${section}`
}

/** Storage key the provider rail's order lives under. */
export const PROVIDER_RAIL_ORDER_KEY = sectionStorageKey(PROVIDER_RAIL_SECTION)

/**
 * Reads the rail order out of a preferences-shaped `order` record. Returns an
 * empty array for anything malformed so a corrupt document degrades to the
 * computed order rather than throwing inside a render.
 */
export function readRailOrder(order: Record<string, unknown> | undefined): string[] {
  const value = order?.[PROVIDER_RAIL_ORDER_KEY]
  if (!Array.isArray(value)) return []
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : []
}

/**
 * Orders providers by the persisted rail order, leaving providers the snapshot
 * has never seen in their incoming (computed) position. Same semantics as every
 * other selector section — see `applySectionOrder`.
 */
export function applyProviderRailOrder<T extends { id: string }>(providers: T[], order: string[] | undefined): T[] {
  return applySectionOrder(providers, order, (provider) => provider.id)
}
