import { createEffect, onCleanup } from "solid-js"
import type { ModelSelectorPreferences } from "@opencode-ai/schema/model-select/preferences"

/**
 * Publishes this client's model-selector preferences to the server so the
 * paired PWA can render the same provider rail order, favorites, recents and
 * routing pins the desktop shows.
 *
 * The desktop's own copy lives in `Persist.global("model")`, an Electron
 * app-data file no other device can read. The server is the only thing the
 * desktop and the phone both talk to, so it holds the shared document (see
 * `preference/model-preferences.ts` and `/global/preferences`).
 *
 * Direction and conflict rules, deliberately narrow:
 *
 * - This client never writes back into its own store from the server. A merge
 *   on startup is exactly where preferences get silently lost, and the desktop
 *   is the device the user configures.
 * - It pushes only the fields whose serialization actually changed since the
 *   last successful write. Sending the whole document on every change would
 *   erase a favorite the phone added between two desktop edits.
 * - On mount it reads the server document once, purely to decide what to seed:
 *   a field the server already has is recorded as "already published" and left
 *   alone; a field only this client has is pushed. So a fresh desktop adopts
 *   nothing and clobbers nothing.
 *
 * Every request is best-effort. A server that is old, unreachable, or does not
 * implement the endpoint must never break model selection, so failures are
 * swallowed after a single warning per session.
 */

const PUSH_DEBOUNCE_MS = 400

/** The publishable subset of the model store, in wire shape. */
export type ModelPreferencesSnapshot = {
  order: Record<string, string[]>
  favorite: string[]
  recent: { providerID: string; modelID: string }[]
  subProvider: Record<string, string>
  variant: Record<string, string>
}

type Field = keyof ModelPreferencesSnapshot

const FIELDS: Field[] = ["order", "favorite", "recent", "subProvider", "variant"]

type PreferencesClient = {
  get: () => Promise<{ data?: ModelSelectorPreferences | undefined } | undefined>
  update: (input: { modelPreferencesPatch: Partial<ModelPreferencesSnapshot> }) => Promise<unknown>
}

function serialize(value: unknown) {
  return JSON.stringify(value ?? null)
}

/** True when the field carries nothing worth publishing. */
function isEmpty(value: unknown) {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === "object") return Object.keys(value).length === 0
  return value === undefined || value === null
}

export function createModelPreferencesSync(input: {
  /** Resolved lazily: the server connection can change under this context. */
  client: () => PreferencesClient | undefined
  /** Reactive snapshot of the publishable store fields. */
  snapshot: () => ModelPreferencesSnapshot
  /** Gate: nothing is published before the persisted store has hydrated. */
  ready: () => boolean
}) {
  // Serialization of the last value this client is confident the server holds,
  // per field. Fields absent here have never been published by anyone.
  const published = new Map<Field, string>()
  let seeded = false
  let warned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: Promise<void> | undefined
  let pending = false

  const warn = (error: unknown) => {
    if (warned) return
    warned = true
    console.warn("[model-preferences] sync unavailable; the PWA will fall back to its local order", error)
  }

  // Records what the server already has so the first flush seeds only the
  // fields nobody has published yet.
  const seed = async () => {
    if (seeded) return
    seeded = true
    const client = input.client()
    if (!client) return
    try {
      const response = await client.get()
      const remote = response?.data
      if (!remote) return
      for (const field of FIELDS) {
        const value = (remote as Record<string, unknown>)[field]
        if (!isEmpty(value)) published.set(field, serialize(value))
      }
    } catch (error) {
      warn(error)
    }
  }

  const flush = async () => {
    const client = input.client()
    if (!client) return
    await seed()

    const current = input.snapshot()
    const patch: Partial<ModelPreferencesSnapshot> = {}
    const sent = new Map<Field, string>()
    for (const field of FIELDS) {
      const value = current[field]
      const encoded = serialize(value)
      if (published.get(field) === encoded) continue
      // Never publish an empty field the server has never seen: that is the
      // shape of a store that has not hydrated, not a deliberate reset.
      if (isEmpty(value) && !published.has(field)) continue
      ;(patch as Record<string, unknown>)[field] = value
      sent.set(field, encoded)
    }
    if (sent.size === 0) return

    try {
      await client.update({ modelPreferencesPatch: patch })
      for (const [field, encoded] of sent) published.set(field, encoded)
    } catch (error) {
      warn(error)
    }
  }

  // Serialized: a flush that lands while another is in flight is deferred
  // rather than racing it, so `published` can never record a stale write.
  const run = () => {
    if (inflight) {
      pending = true
      return
    }
    inflight = flush().finally(() => {
      inflight = undefined
      if (!pending) return
      pending = false
      run()
    })
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      run()
    }, PUSH_DEBOUNCE_MS)
  }

  createEffect(() => {
    // Tracked reads: any store mutation reschedules a push. Diffing inside
    // `flush` is what keeps an unrelated change from republishing every field.
    const snapshot = input.snapshot()
    void snapshot
    if (!input.ready()) return
    schedule()
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
}
