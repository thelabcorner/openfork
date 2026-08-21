import { createRoot, getOwner, onCleanup } from "solid-js"

export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const items = new Map<string, T>()
  const disposers = new Map<string, () => void>()
  const refCounts = new Map<string, number>()

  const release = (id: string) => {
    const next = (refCounts.get(id) ?? 0) - 1
    refCounts.set(id, next)
    if (next > 0) return
    disposers.get(id)?.()
    disposers.delete(id)
    remove?.(id)
    items.delete(id)
    refCounts.delete(id)
  }

  return (key: string) => {
    const id = identity(key)
    if (getOwner()) onCleanup(() => release(id))

    const cached = items.get(id)
    if (cached) {
      refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
      return cached
    }
    // `create` runs inside its own root so any onCleanup it registers internally
    // (e.g. createDirSdkContext's event-relay unsubscribe) is tied to the item's
    // own lifetime, not to whichever caller's reactive scope happened to trigger
    // creation. Without this, the FIRST consumer to unmount (e.g. one of several
    // tabs open on the same directory closing) disposes shared internal state out
    // from under every OTHER still-live consumer of the same key -- silently
    // killing event delivery for them until a full reload recreates everything.
    let item!: T
    const dispose = createRoot((dispose) => {
      item = create(key)
      return dispose
    })
    items.set(id, item)
    disposers.set(id, dispose)
    refCounts.set(id, 1)
    return item
  }
}
