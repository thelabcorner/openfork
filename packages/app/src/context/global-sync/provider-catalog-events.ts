import { directoryKey } from "./utils"

/** Catalog revisions invalidate one materialized location query, never rows. */
export function providerCatalogQueryMatches(
  key: readonly unknown[],
  scope: string,
  directory: string | undefined,
) {
  if (key[0] !== scope || key[2] !== "providers") return false
  return directory === undefined ? key[1] === null : key[1] === directoryKey(directory)
}

export function providerCatalogRevision(value: unknown):
  { directory?: string; revision: number } | undefined {
  if (!value || typeof value !== "object") return undefined
  const props = value as Record<string, unknown>
  if (!Number.isSafeInteger(props.revision) || (props.revision as number) < 0) return undefined
  if (props.directory !== undefined && (typeof props.directory !== "string" || !props.directory)) return undefined
  return { directory: props.directory as string | undefined, revision: props.revision as number }
}

/** Retain latest intent while a cold snapshot is in flight. */
export function createProviderCatalogRefresh() {
  const states = new WeakMap<object, { revision: number; applied: number; running?: Promise<void> }>()
  return (query: object, revision: number, input: {
    pending: () => Promise<unknown> | undefined
    refresh: (revision: number) => Promise<unknown>
  }): Promise<void> => {
    const state = states.get(query) ?? { revision: -1, applied: -1, running: undefined }
    states.set(query, state)
    if (revision <= state.applied || (state.running && revision <= state.revision))
      return state.running ?? Promise.resolve()
    state.revision = Math.max(revision, state.revision)
    if (state.running) return state.running
    const run = async () => {
      for (;;) {
        // TanStack deduplicates invalidation against an unresolved cold fetch.
        // Wait for that snapshot first, then demand the newer owner revision.
        await input.pending()?.catch(() => undefined)
        const desired = state.revision
        await input.refresh(desired)
        state.applied = desired
        if (desired === state.revision) return
      }
    }
    state.running = run().finally(() => { state.running = undefined })
    return state.running
  }
}
