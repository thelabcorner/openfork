/**
 * Coordinate the expensive full-history Context ledger request across multiple
 * observers. At most one backend read per session runs at a time, with one
 * trailing refresh when an authoritative settlement arrives during the read.
 *
 * Invalidation prevents stale results and queued requests from reaching the
 * active pane, including when navigating A -> B -> A. The underlying HTTP
 * request can still finish after navigation; it does not start another read.
 */
export function createSessionContextLedgerRequest<T>(options: {
  load: (sessionID: string) => Promise<T>
  currentSession: () => string | undefined
  receive: (value: T) => void
  error: (reason: unknown) => void
}) {
  let revision = 0
  let pending: { sessionID: string; promise: Promise<void> } | undefined
  let trailing: { sessionID: string; promise: Promise<void> } | undefined

  const invalidate = () => {
    revision++
    pending = undefined
    trailing = undefined
  }

  const start = (sessionID: string): Promise<void> => {
    const ownRevision = ++revision
    const promise = Promise.resolve()
      .then(() => options.load(sessionID))
      .then((value) => {
        if (ownRevision !== revision || options.currentSession() !== sessionID) return
        options.receive(value)
      })
      .catch((reason: unknown) => {
        if (ownRevision !== revision || options.currentSession() !== sessionID) return
        options.error(reason)
      })
      .finally(() => {
        if (pending?.promise === promise) pending = undefined
      })
    pending = { sessionID, promise }
    return promise
  }

  const read = (sessionID: string | undefined, fresh = false): Promise<void> => {
    if (!sessionID) return Promise.resolve()
    if (pending?.sessionID !== sessionID) {
      // An earlier session may have an uncancellable HTTP request in progress.
      // Drop ownership immediately rather than permitting its response to win.
      invalidate()
    }
    if (!pending) return start(sessionID)
    if (!fresh) return trailing?.promise ?? pending.promise
    if (trailing) return trailing.promise

    // Supersede the in-flight result without overlapping two full-history
    // queries. Multiple settlements during one query coalesce into one rerun.
    const ownRevision = ++revision
    const current = pending.promise
    const promise = current.then(() => {
      if (ownRevision !== revision || options.currentSession() !== sessionID) return
      trailing = undefined
      return start(sessionID)
    })
    trailing = { sessionID, promise }
    return promise
  }

  return { read, invalidate }
}
