export class VisualRequestTracker {
  private readonly byRequest = new Map<string, { tabId: number; interruption?: string }>()

  tryTrack(requestId: string, tabId: number): boolean {
    for (const candidate of this.byRequest.values()) {
      if (candidate.tabId === tabId) return false
    }
    this.byRequest.set(requestId, { tabId })
    return true
  }

  untrack(requestId: string): void {
    this.byRequest.delete(requestId)
  }

  tabId(requestId: string): number | undefined {
    return this.byRequest.get(requestId)?.tabId
  }

  interrupt(requestId: string, reason: string): boolean {
    const entry = this.byRequest.get(requestId)
    if (!entry) return false
    entry.interruption ??= reason
    return true
  }

  interruption(requestId: string): string | undefined {
    return this.byRequest.get(requestId)?.interruption
  }

  requestIdsForTab(tabId: number): string[] {
    const out: string[] = []
    for (const [requestId, candidate] of this.byRequest) {
      if (candidate.tabId === tabId) out.push(requestId)
    }
    return out
  }

  get size(): number {
    return this.byRequest.size
  }
}

export async function abortVisualRequestsForTab(
  tracker: VisualRequestTracker,
  tabId: number,
  reason: string,
  sendAbort: (tabId: number, requestId: string) => Promise<unknown>,
): Promise<number> {
  const requestIds = tracker.requestIdsForTab(tabId)
  for (const requestId of requestIds) tracker.interrupt(requestId, reason)
  await Promise.allSettled(requestIds.map((requestId) => sendAbort(tabId, requestId)))
  return requestIds.length
}
