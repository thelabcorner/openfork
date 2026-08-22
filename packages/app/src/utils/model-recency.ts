import { DateTime } from "luxon"

// How recent a release date must be for a model to count as newly added.
export const RECENT_MODEL_WINDOW_MONTHS = 6

function withinRecentWindow(date: DateTime): boolean {
  return date.isValid && Math.abs(date.diffNow().as("months")) < RECENT_MODEL_WINDOW_MONTHS
}

/** True when a release date falls inside the recent window (or is future-
 * dated) — the shared "newly added" test used for default visibility and
 * latest-tagging. */
export { withinRecentWindow }

/** Default visibility for a model the user has NEVER toggled: newly-added
 * models are AUTO-ENABLED — anything released inside the recent window (or
 * dated in the future) and any entry with no parseable release date is on by
 * default. Only releases that aged out of the window default to off (opt in
 * via Manage models). Explicit user show/hide always wins over this. */
export function isRecentModelRelease(date: DateTime | undefined): boolean {
  if (!date?.isValid) return true
  return withinRecentWindow(date)
}
