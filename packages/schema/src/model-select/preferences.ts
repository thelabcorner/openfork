/**
 * The model-selector preferences document that every OpenCode client shares
 * through the server (`GET`/`PATCH /global/preferences`).
 *
 * Why this exists: the desktop renderer keeps its selector state in
 * `Persist.global("model")`, which is a file inside the Electron app-data
 * directory. The PWA runs in a browser on a different device and can never read
 * that file, so a phone paired to a desktop showed the provider rail in
 * whatever order its own catalog happened to produce, with none of the
 * desktop's favorites, recents or routing pins. Routing the same document
 * through the server the two already share makes the phone a view of one set of
 * preferences rather than a second, divergent set.
 *
 * Deliberately dependency-free (no `effect`, no SDK): the PWA bundles this, and
 * the server's wire schema is declared separately in the httpapi group.
 *
 * Collections are `readonly` because the server decodes them out of an
 * `effect/Schema`, which produces readonly arrays and records. Callers holding
 * mutable arrays can still pass them in.
 */

/** `providerID:modelID`, the key every selector section is ordered by. */
export type ModelKeyString = string

export type ModelRecentEntry = {
  readonly providerID: string
  readonly modelID: string
}

export type ModelSelectorPreferences = {
  /**
   * Per-section manual order. Keys are the section keys produced by
   * `sectionStorageKey` — `section:favorites`, `section:provider:<id>`, and
   * `section:provider:rail` for the provider rail itself. Values are full
   * ordered snapshots; entries missing from a snapshot keep their computed
   * position (see `applySectionOrder`).
   */
  readonly order?: Readonly<Record<string, readonly ModelKeyString[]>>
  /** Favorited models, as `providerID:modelID`. */
  readonly favorite?: readonly ModelKeyString[]
  /** Most-recently-used models, newest first. */
  readonly recent?: readonly ModelRecentEntry[]
  /** OpenRouter upstream-provider pin, keyed by `providerID:modelID`. */
  readonly subProvider?: Readonly<Record<string, string>>
  /** Per-model reasoning-effort variant, keyed by `providerID:modelID`. */
  readonly variant?: Readonly<Record<string, string>>
  /** Epoch millis of the last write. Advisory; the server owns the value. */
  readonly updatedAt?: number
}

/**
 * A partial write. Every field is optional so a client only sends what it
 * changed — a phone toggling one favorite must not be able to roll back a
 * desktop rail reorder it never saw. `order`, `subProvider` and `variant` are
 * merged per key; `favorite` and `recent` are whole-list replacements, because
 * they are edited as a unit.
 *
 * Deletions travel in `remove` rather than as `null` record values: the OpenAPI
 * emitter collapses a nullable union to its non-null branch, so a `null` here
 * would work at runtime but be absent from the published contract and from the
 * generated client's types.
 */
export type ModelSelectorPreferencesPatch = {
  readonly order?: Readonly<Record<string, readonly ModelKeyString[]>>
  readonly favorite?: readonly ModelKeyString[]
  readonly recent?: readonly ModelRecentEntry[]
  readonly subProvider?: Readonly<Record<string, string>>
  readonly variant?: Readonly<Record<string, string>>
  /** Keys to drop, applied after the merges above. */
  readonly remove?: {
    readonly order?: readonly string[]
    readonly subProvider?: readonly string[]
    readonly variant?: readonly string[]
  }
}

export const EMPTY_PREFERENCES: ModelSelectorPreferences = {}

function mergeRecord<T>(
  base: Readonly<Record<string, T>> | undefined,
  patch: Readonly<Record<string, T>> | undefined,
  remove: readonly string[] | undefined,
): Record<string, T> | undefined {
  if (!patch && !remove?.length) return base ? { ...base } : undefined
  const next: Record<string, T> = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    next[key] = value
  }
  for (const key of remove ?? []) delete next[key]
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Applies a patch to a stored document. Pure and total: shared by the server
 * handler and by client-side optimistic updates so the two cannot disagree
 * about what a partial write means.
 */
export function mergePreferences(
  base: ModelSelectorPreferences | undefined,
  patch: ModelSelectorPreferencesPatch,
  now = Date.now(),
): ModelSelectorPreferences {
  const current = base ?? EMPTY_PREFERENCES
  const next: {
    order?: Record<string, readonly ModelKeyString[]>
    favorite?: readonly ModelKeyString[]
    recent?: readonly ModelRecentEntry[]
    subProvider?: Record<string, string>
    variant?: Record<string, string>
    updatedAt?: number
  } = {
    order: mergeRecord(current.order, patch.order, patch.remove?.order),
    favorite: patch.favorite ?? current.favorite,
    recent: patch.recent ?? current.recent,
    subProvider: mergeRecord(current.subProvider, patch.subProvider, patch.remove?.subProvider),
    variant: mergeRecord(current.variant, patch.variant, patch.remove?.variant),
    updatedAt: now,
  }
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (next[key] === undefined) delete next[key]
  }
  return next
}
