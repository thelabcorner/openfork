import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { sessionStatusIsWorking } from "@/utils/session-status"

/**
 * The server-owned status map is sparse: idle sessions have no entry. Materialize
 * busy/retrying, unpaused session identities once per map change rather than
 * subscribing a dense 10,000-row sort to every individual status/paused slot.
 *
 * The owner remains server-session; this is a read-only derived index and
 * introduces no timers, message hydration, or per-session event subscriptions.
 */
export function indexChatSidebarWorkingIDs(
  statuses: Readonly<Record<string, SessionStatus | undefined>>,
  paused: Readonly<Record<string, boolean | undefined>>,
): ReadonlySet<string> {
  const working = new Set<string>()
  for (const [id, status] of Object.entries(statuses)) {
    if (!sessionStatusIsWorking(status?.type) || paused[id] === true) continue
    working.add(id)
  }
  return working
}