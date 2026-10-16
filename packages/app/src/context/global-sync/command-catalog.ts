type Entry<T> = {
  request: Promise<T[]>
  committed: boolean
}

/** One command-catalog request per explicit directory, shared by slash UI and submit. */
export function createCommandCatalogOwner<T>(input: {
  load: (directory: string) => Promise<T[]>
  commit: (directory: string, commands: T[]) => void
}) {
  const entries = new Map<string, Entry<T>>()

  const ensure = async (directory: string, isCurrent?: () => boolean) => {
    let entry = entries.get(directory)
    if (!entry) {
      const request = input.load(directory)
      entry = { request, committed: false }
      entries.set(directory, entry)
      void request.catch(() => {
        if (entries.get(directory) === entry) entries.delete(directory)
      })
    }
    const commands = await entry.request
    if (isCurrent && !isCurrent()) return []
    if (entries.get(directory) !== entry) return ensure(directory, isCurrent)
    if (!entry.committed) {
      entry.committed = true
      input.commit(directory, commands)
    }
    return commands
  }

  return {
    ensure,
    invalidate(directory: string) {
      entries.delete(directory)
    },
  }
}
