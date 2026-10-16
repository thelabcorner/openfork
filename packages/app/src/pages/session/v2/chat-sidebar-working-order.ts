import type { Session } from "@opencode-ai/sdk/v2/client"

/**
 * Arrival order is a pane-lifetime presentation policy, NOT a second source of
 * execution truth. The caller supplies the authoritative sparse working set.
 *
 * Keeping the policy in one owner means Projects can pin only changed sections,
 * while Recent/Status share the same arrival sequence. An all-idle cold paint
 * returns the original array without walking or allocating 10,000 row objects.
 */
export function createChatSidebarWorkingOrder() {
  const arrivals = new Map<string, number>()
  let sequence = 0
  return {
    prune(present: ReadonlySet<string>, working: ReadonlySet<string>) {
      for (const id of arrivals.keys()) if (!present.has(id) || !working.has(id)) arrivals.delete(id)
    },
    pin(rows: Session[], working: ReadonlySet<string>): Session[] {
      if (working.size === 0) {
        arrivals.clear()
        return rows
      }
      const pinned: Array<{ seq: number; session: Session }> = []
      const rest: Session[] = []
      for (const session of rows) {
        if (!working.has(session.id)) {
          arrivals.delete(session.id)
          rest.push(session)
          continue
        }
        const known = arrivals.get(session.id)
        const seq = known ?? ++sequence
        if (known === undefined) arrivals.set(session.id, seq)
        pinned.push({ seq, session })
      }
      if (pinned.length === 0) return rows
      return [...pinned.sort((a, b) => a.seq - b.seq).map((item) => item.session), ...rest]
    },
    clear() { arrivals.clear() },
  }
}