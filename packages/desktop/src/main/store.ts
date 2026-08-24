import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"

type CachedStore = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  delete: (key: string) => void
  clear: () => void
  has: (key: string) => boolean
  readonly store: Record<string, unknown>
}

const cache = new Map<string, CachedStore>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
//
// conf 15 re-reads + JSON.parse's the whole file on every `.store` / `.get` /
// `.set`. Cache the snapshot so IPC hydrate/write does not re-parse megabyte
// prompt-history on each call.
export function getStore(name = SETTINGS_STORE): CachedStore {
  const cached = cache.get(name)
  if (cached) return cached
  const inner = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  const data = { ...(inner.store as Record<string, unknown>) }
  const persist = () => {
    inner.store = data
  }
  const next: CachedStore = {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
      persist()
    },
    delete: (key) => {
      delete data[key]
      persist()
    },
    clear: () => {
      for (const key of Object.keys(data)) delete data[key]
      persist()
    },
    has: (key) => key in data,
    get store() {
      return data
    },
  }
  cache.set(name, next)
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) cache.delete(name)
}

export function removeStoreFile(name: string) {
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  cache.delete(name)
}
