import { createMemo, type Accessor } from "solid-js"

/**
 * TanStack includes getItemKey function identity in its 50k-row measurement
 * memo. A watcher often changes row metadata without changing the ordered
 * path keys. Keep the resolver identity stable for those metadata-only views;
 * it reads the newest view only when invoked, never closes over stale rows.
 */
export function createProjectExplorerKeyResolver(view: Accessor<{
  keySignature: string
  at(index: number): { node: { path: string } } | undefined
}>) {
  const epoch = createMemo(() => view().keySignature)
  return createMemo(() => {
    epoch()
    return (index: number) => view().at(index)?.node.path ?? index
  })
}
