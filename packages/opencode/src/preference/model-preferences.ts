import path from "path"

import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import {
  mergePreferences,
  type ModelSelectorPreferences,
  type ModelSelectorPreferencesPatch,
} from "@opencode-ai/schema/model-select/preferences"

import { Filesystem } from "@/util/filesystem"

/**
 * Server-side home for the model selector's cross-client preferences: the
 * provider rail order, favorites, recents, and the per-model routing pins.
 *
 * These used to live only in the desktop renderer's `Persist.global("model")`
 * store, which is a file inside the Electron app-data directory. The PWA runs
 * on a different device and cannot read it, so a paired phone rendered the
 * provider rail in whatever order its own catalog happened to produce. Both
 * clients already talk to this server, so it is the one place they can share.
 *
 * Storage is a single JSON document under the global state directory, guarded
 * by the same advisory file lock the other JSON stores use so concurrent
 * desktop/phone writes cannot interleave a lost update. Writes are merge
 * patches (see `mergePreferences`) rather than whole-document replacements:
 * a phone toggling one favorite must not roll back a rail reorder it never saw.
 */

/**
 * Ceiling on the number of keys in each record-valued field. The wire schema
 * bounds string lengths and array lengths, but `effect/Schema` has no filter
 * for a record's key count, so the only place a runaway `order` or
 * `subProvider` map can be stopped is here, before it is written to disk.
 * Excess keys are dropped rather than rejected: this is advisory UI state, and
 * failing a rail reorder because an unrelated map grew would be worse.
 */
const MAX_RECORD_KEYS = 512

function clampRecord<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined {
  if (!value) return undefined
  const entries = Object.entries(value)
  if (entries.length <= MAX_RECORD_KEYS) return { ...value }
  return Object.fromEntries(entries.slice(0, MAX_RECORD_KEYS))
}

function clamp(preferences: ModelSelectorPreferences): ModelSelectorPreferences {
  return {
    ...preferences,
    order: clampRecord(preferences.order),
    subProvider: clampRecord(preferences.subProvider),
    variant: clampRecord(preferences.variant),
  }
}

function storePath() {
  return path.join(Global.Path.state, "model-preferences.json")
}

function lock(file: string) {
  return `model-preferences:${file}`
}

async function read(file: string): Promise<ModelSelectorPreferences> {
  return Filesystem.readJson<ModelSelectorPreferences>(file).catch(() => ({}) as ModelSelectorPreferences)
}

/** Current document. Absent or unreadable state reads as empty, never throws. */
export async function get(): Promise<ModelSelectorPreferences> {
  const file = storePath()
  return Flock.withLock(lock(file), async () => read(file))
}

/** Applies a merge patch and returns the resulting document. */
export async function update(patch: ModelSelectorPreferencesPatch): Promise<ModelSelectorPreferences> {
  const file = storePath()
  return Flock.withLock(lock(file), async () => {
    const next = clamp(mergePreferences(await read(file), patch))
    await Filesystem.writeJson(file, next)
    return next
  })
}

export * as ModelPreferences from "./model-preferences"
