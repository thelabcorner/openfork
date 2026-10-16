/**
 * Lazy, bounded Context ledger paging.
 *
 * The wire returns each page chronologically. This controller owns the
 * newest-first inspection view, deduplicates concurrent requests, and fences
 * every async response against Session switches, mutation refreshes and
 * cleanup. A stale keyset cursor is discarded with its entire partial snapshot.
 *
 * No individual page is mistaken for full-history token/count totals.
 */
export type ContextLedgerPage<T> = {
  entries: T[]
  revision?: number
  /** Optional full-session totals, computed server-side from durable facts. */
  authoritativeTotals?: ContextLedgerPageState<T>["totals"]
  hasMore: boolean
  nextCursor?: string
  mode: "chronological" | "compacted"
}

export type ContextLedgerPageState<T> = {
  /** Flatten only for callers that explicitly need a materialized full list. */
  entries: T[]
  pages: readonly (readonly T[])[]
  loadedCount: number
  revision?: number
  totals: {
    messageCount: number
    excludedCount: number
    pinnedCount: number
    editedCount: number
    estimatedTokens: number
    estimatedTokensExcluded: number
  }
  authoritativeTotals?: ContextLedgerPageState<T>["totals"]
  hasMore: boolean
  nextCursor?: string
  mode: "chronological" | "compacted"
  complete: boolean
}

export function createSessionContextLedgerPager<T extends { messageID: string }>(options: {
  load: (sessionID: string, cursor?: string) => Promise<ContextLedgerPage<T>>
  /** Independent slow-lane aggregate; never blocks the first page. */
  loadTotals?: (sessionID: string) => Promise<{
    revision: number
    totals?: ContextLedgerPageState<T>["totals"]
  }>
  currentSession: () => string | undefined
  receive: (state: ContextLedgerPageState<T> | null) => void
  error: (reason: unknown) => void
  classify?: (entry: T) => { excluded: boolean; pinned: boolean; edited: boolean; tokenEstimate: number }
}) {
  let revision = 0
  let session: string | undefined
  let latest: ContextLedgerPageState<T> | undefined
  let pending: Promise<void> | undefined
  let seen = new Set<string>()

  const invalidate = () => {
    revision++
    session = undefined
    latest = undefined
    pending = undefined
    seen = new Set()
    options.receive(null)
  }

  const start = (sessionID: string, cursor: string | undefined, continuation: boolean) => {
    const ownerRevision = revision
    let promise!: Promise<void>
    promise = Promise.resolve()
      .then(() => options.load(sessionID, cursor))
      .then((page) => {
        if (revision !== ownerRevision || session !== sessionID || options.currentSession() !== sessionID) return
        if (page.hasMore && !page.nextCursor) throw new Error("Context ledger returned an incomplete cursor")
        if (continuation && latest?.mode !== page.mode)
          throw new Error("Context ledger changed mode during pagination")
        if (continuation && latest?.revision !== undefined && page.revision !== latest.revision)
          throw new Error("Context ledger changed during pagination")
        if (continuation && page.authoritativeTotals)
          throw new Error("Context ledger returned incompatible continuation totals")
        // When both sides complete, the backend's chronological entry order is
        // inverted once per page. Prepending older pages would corrupt order.
        const additions = [...page.entries].reverse()
        const inPage = new Set<string>()
        for (const entry of additions) {
          if (seen.has(entry.messageID) || inPage.has(entry.messageID))
            throw new Error("Context ledger returned duplicate messages across pages")
          inPage.add(entry.messageID)
        }
        // Validate before committing Set mutations. Each additional page now
        // touches only new IDs, not every previously loaded ID.
        for (const id of inPage) seen.add(id)
        const pages = [...(continuation ? latest?.pages ?? [] : []), additions]
        const totals = continuation && latest ? { ...latest.totals } : {
          messageCount: 0,
          excludedCount: 0,
          pinnedCount: 0,
          editedCount: 0,
          estimatedTokens: 0,
          estimatedTokensExcluded: 0,
        }
        for (const entry of additions) {
          totals.messageCount++
          const facts = options.classify?.(entry)
          if (!facts) continue
          if (facts.excluded) {
            totals.excludedCount++
            totals.estimatedTokensExcluded += facts.tokenEstimate
          } else totals.estimatedTokens += facts.tokenEstimate
          if (facts.pinned) totals.pinnedCount++
          if (facts.edited) totals.editedCount++
        }
        // Solid's nested <For> consumes stable chunks; legacy/test callers can
        // request an entire list through this cached lazy compatibility getter.
        let flattened: T[] | undefined
        latest = {
          get entries() { return flattened ??= pages.flat() },
          pages,
          loadedCount: totals.messageCount,
          revision: page.revision,
          totals,
          authoritativeTotals: continuation ? latest?.authoritativeTotals : page.authoritativeTotals,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          mode: page.mode,
          complete: !page.hasMore,
        }
        options.receive(latest)
        if (!continuation && !page.authoritativeTotals && page.revision !== undefined && options.loadTotals) {
          // A separate scan lane computes full-history counts. Capture both the
          // generation and durable event revision so a late result cannot
          // corrupt a refreshed or navigated ledger.
          void Promise.resolve()
            .then(() => options.loadTotals!(sessionID))
            .then((result) => {
              if (revision !== ownerRevision || session !== sessionID ||
                options.currentSession() !== sessionID || latest?.revision !== result.revision ||
                !result.totals) return
              const previous = latest
              // Do NOT spread a page state: `entries` is deliberately a lazy
              // compatibility getter. Spreading invokes that getter and
              // materializes/retains every loaded row during a totals-only
              // update, defeating bounded inspection and virtualization.
              latest = {
                get entries() { return previous.entries },
                pages: previous.pages,
                loadedCount: previous.loadedCount,
                revision: previous.revision,
                totals: previous.totals,
                authoritativeTotals: result.totals,
                hasMore: previous.hasMore,
                nextCursor: previous.nextCursor,
                mode: previous.mode,
                complete: previous.complete,
              }
              options.receive(latest)
            })
            .catch(() => {
              // Totals are additive metadata. Failure does not discard working
              // pages or fabricate full-history estimates from loaded rows.
            })
        }
      })
      .catch((reason) => {
        if (revision !== ownerRevision || session !== sessionID || options.currentSession() !== sessionID) return
        // A cursor rejected after an authoritative writer advanced the
        // aggregate may no longer be replayed. Drop *all* partial rows so a
        // subsequent explicit retry starts at the newest committed revision.
        const detail = reason instanceof Error ? reason.message : String(reason)
        if (continuation && /changed during pagination|cursor no longer exists|history changed/i.test(detail)) {
          invalidate()
        }
        options.error(reason)
      })
      .finally(() => {
        if (pending === promise) pending = undefined
      })
    pending = promise
    return promise
  }

  const read = (sessionID: string | undefined, fresh = false): Promise<void> => {
    if (!sessionID) return Promise.resolve()
    if (session !== sessionID || fresh) {
      invalidate()
      session = sessionID
    } else {
      if (pending) return pending
      if (latest) return Promise.resolve()
    }
    return start(sessionID, undefined, false)
  }

  const more = (): Promise<void> => {
    if (pending) return pending
    if (!session || !latest?.hasMore || !latest.nextCursor) return Promise.resolve()
    return start(session, latest.nextCursor, true)
  }

  return { read, more, invalidate }
}
