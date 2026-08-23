import { createStore } from "solid-js/store"

export type PendingWork = {
  id: number
  label: string
  started: number
  done: boolean
}

let next = 0
const [store, setStore] = createStore({ items: [] as PendingWork[] })

export function trackPending(label: string) {
  const id = ++next
  const started = Date.now()
  setStore("items", (items) => {
    // Deduplicate by label: replace an existing entry with the same label
    // so workspace bootstrapping (many workspace:vcs/project/icon entries)
    // and repeated fork.credentials/usage calls don't accumulate unbounded
    // duplicates. Keeps the array bounded and the diagnostic readable.
    const existingIndex = items.findIndex((item) => item.label === label && !item.done)
    const nextItems = existingIndex >= 0 ? items.filter((_, i) => i !== existingIndex) : [...items]
    return [...nextItems, { id, label, started, done: false }]
  })
  return () => setStore("items", (item) => item.id === id, "done", true)
}

export function pendingWork() {
  return store.items
}
