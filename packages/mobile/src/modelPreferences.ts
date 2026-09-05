import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import {
  mergePreferences,
  type ModelSelectorPreferences,
  type ModelSelectorPreferencesPatch,
} from "@opencode-ai/schema/model-select/preferences"
import {
  applyProviderRailOrder,
  FAVORITES_SECTION,
  PROVIDER_RAIL_SECTION,
  readRailOrder,
  sectionStorageKey,
} from "@opencode-ai/schema/model-select/rail-order"

export { FAVORITES_SECTION, PROVIDER_RAIL_SECTION, sectionStorageKey }

/**
 * Key an OpenRouter upstream pin is stored under.
 *
 * Deliberately the *base* model id: a pin is a property of the model, not of
 * whichever account variant happens to be selected, so `model@wb-a` and
 * `model@wb-b` resolve to the same pin. Both the picker (which writes) and the
 * send path (which reads) must agree on this, so it lives here rather than
 * being spelled out twice.
 */
export function subProviderKeyFor(providerID: string, modelID: string): string {
  return `${providerID}:${splitModelIDForProvider(modelID, providerID).baseModelID}`
}

/**
 * The model selector's preferences, shared with the desktop through the server.
 *
 * The desktop keeps this document in `Persist.global("model")`, a file inside
 * the Electron app-data directory that a phone can never read, so a paired PWA
 * used to render its provider rail in whatever order its own catalog happened
 * to produce. `GET`/`PATCH /global/preferences` is the seam both clients now
 * share.
 *
 * Everything here is written optimistically: the local copy is updated and
 * persisted immediately, then pushed. That matters because the phone is on a
 * phone network - a rail drag must feel instant even when the PATCH takes a
 * second or never lands. If the push fails we keep the local value and stay
 * dirty, so the next successful load reconciles rather than silently losing
 * the user's order.
 */

const STORE_KEY = "opencode.mobile.modelPreferences"

/** Optimistic local state, degraded to localStorage when offline or on error. */
type LocalState = ModelSelectorPreferences

function readLocal(): LocalState {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ModelSelectorPreferences
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeLocal(state: LocalState) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch {
    // Storage is an optimization; the in-memory copy stays authoritative.
  }
}

export type ModelPreferencesStoreInput = {
  /** Live client, absent while disconnected or before pairing. */
  client: () => OpencodeClient | undefined
}

export function createModelPreferences(input: ModelPreferencesStoreInput) {
  let state: LocalState = readLocal()
  /** True when a local write has not been confirmed by the server. */
  let dirty = false
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const setState = (next: LocalState, persist = true) => {
    state = next
    if (persist) writeLocal(state)
    emit()
  }

  /** Pulls the server document. A failure leaves the local copy untouched. */
  const load = async () => {
    const client = input.client()
    if (!client) return
    try {
      const response = await client.global.preferences.get({ throwOnError: true })
      const remote = (response.data ?? {}) as ModelSelectorPreferences
      // A stale local write that never reached the server is more recent truth
      // than whatever the server currently holds, so merge over it rather than
      // replacing: this keeps a rail drag made offline.
      const merged = dirty ? { ...remote, ...state } : remote
      dirty = false
      setState(merged)
    } catch {
      // Offline, unpaired, or a server predating the endpoint. The locally
      // cached document (possibly seeded from localStorage) still applies.
    }
  }

  const push = async (patch: ModelSelectorPreferencesPatch) => {
    const client = input.client()
    if (!client) {
      dirty = true
      return
    }
    try {
      const response = await client.global.preferences.update(
        { modelPreferencesPatch: patch as never },
        { throwOnError: true },
      )
      const remote = (response.data ?? {}) as ModelSelectorPreferences
      dirty = false
      setState({ ...remote, ...state })
    } catch {
      dirty = true
      writeLocal(state)
    }
  }

  const apply = (patch: ModelSelectorPreferencesPatch) => {
    setState(mergePreferences(state, patch))
    void push(patch)
  }

  return {
    /** Reactive accessor - re-renders subscribers after any mutation. */
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,

    /** Full ordered snapshot of one selector section. */
    orderFor: (section: string): readonly string[] => state.order?.[sectionStorageKey(section)] ?? [],
    /** Writes a section order as a full snapshot (drag-to-reorder semantics). */
    setOrder: (section: string, ids: string[]) => {
      apply({ order: { [sectionStorageKey(section)]: ids } })
    },

    /** Provider rail order, shared with the desktop. */
    railOrder: (): string[] => readRailOrder(state.order as Record<string, unknown> | undefined),
    /** Orders providers by the persisted rail order. */
    applyRail: <T extends { id: string }>(providers: T[]): T[] => applyProviderRailOrder(providers, readRailOrder(state.order as Record<string, unknown> | undefined)),

    favorites: (): readonly string[] => state.favorite ?? [],
    setFavorites: (keys: string[]) => apply({ favorite: keys }),
    isFavorite: (key: string) => (state.favorite ?? []).includes(key),

    recents: () => state.recent ?? [],
    setRecents: (entries: ModelSelectorPreferences["recent"]) => apply({ recent: entries }),

    /**
     * Pinned OpenRouter upstream provider for a model, if any.
     *
     * A stored empty string is treated as unpinned: some stores serialise a
     * cleared value as "" rather than removing the key, and sending
     * `provider: { only: [""] }` would break every request.
     */
    subProviderFor: (key: string): string | undefined => state.subProvider?.[key] || undefined,
    /** Passing `undefined` clears the pin, which travels in `remove`. */
    setSubProvider: (key: string, value: string | undefined) => {
      apply(value === undefined ? { remove: { subProvider: [key] } } : { subProvider: { [key]: value } })
    },

    variantFor: (key: string): string | undefined => state.variant?.[key] || undefined,
    setVariant: (key: string, value: string | undefined) => {
      apply(value === undefined ? { remove: { variant: [key] } } : { variant: { [key]: value } })
    },
  }
}

export type ModelPreferencesStore = ReturnType<typeof createModelPreferences>
