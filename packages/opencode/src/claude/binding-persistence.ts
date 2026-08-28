import { Effect } from "effect"
import { Storage } from "@/storage/storage"
import type { Binding, BindingStorage } from "./sessions"
import { SessionBindingError } from "./errors"

// Storage-backed BindingStorage. Persists under
// Global.Path.data/storage/claude/binding/<project>/<session>.json
// Only our binding JSON is written/removed; Claude transcripts are never touched.
export function makeStorageBindingStorage(storage: Storage.Interface): BindingStorage {
  return {
    read: (key) =>
      storage.read<Binding>(key).pipe(
        Effect.mapError((cause) => {
          const tag = (cause as any)?._tag ?? (cause as any)?.name
          if (tag === "NotFoundError" || cause instanceof Storage.NotFoundError) {
            return new SessionBindingError({ code: "not_found", message: `binding not found: ${key.join("/")}` })
          }
          return new SessionBindingError({ code: "stale", message: String((cause as any)?.message ?? cause) })
        }),
      ),
    write: (key, binding) => storage.write(key, binding).pipe(Effect.orDie),
    remove: (key) => storage.remove(key).pipe(Effect.orDie),
    list: (prefix) => storage.list(prefix).pipe(Effect.orDie),
  }
}

export const bindingStorageFromService = Effect.gen(function* () {
  const storage = yield* Storage.Service
  return makeStorageBindingStorage(storage)
})

export * as ClaudeBindingPersistence from "./binding-persistence"
