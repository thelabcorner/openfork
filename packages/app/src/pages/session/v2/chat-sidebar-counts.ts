import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { sessionStatusIsWorking } from "@/utils/session-status"

/** Compact count projections consume existing authoritative server-session state.
 * Unlike walking all loaded rows, this does work only for status/pending entries.
 * The caller supplies a session-scope index built once from its roots/groups.
 */
export function countSidebarWorking(
  visible: ReadonlySet<string>,
  statuses: Readonly<Record<string, SessionStatus | undefined>>,
  paused: Readonly<Record<string, boolean | undefined>>,
): number {
  let count = 0
  for (const [id, status] of Object.entries(statuses)) {
    if (!visible.has(id) || !sessionStatusIsWorking(status?.type) || paused[id] === true) continue
    count++
  }
  return count
}

/** A session can appear in multiple structural groups. Preserve the original
 * OR semantics if conflicting memberships report different directory scopes.
 */
export function countSidebarWaiting<T>(
  visibleDirectories: ReadonlyMap<string, ReadonlySet<string>>,
  questions: Readonly<Record<string, readonly unknown[] | undefined>>,
  permissions: Readonly<Record<string, readonly T[] | undefined>>,
  autoResponds: (request: T, directory: string) => boolean,
): number {
  const attention = new Set<string>()
  for (const [id, rows] of Object.entries(questions)) {
    if (rows?.length && visibleDirectories.has(id)) attention.add(id)
  }
  for (const [id, rows] of Object.entries(permissions)) {
    if (!rows?.length || attention.has(id)) continue
    const directories = visibleDirectories.get(id)
    if (!directories) continue
    outer: for (const directory of directories) {
      for (const request of rows) {
        if (autoResponds(request, directory)) continue
        attention.add(id)
        break outer
      }
    }
  }
  return attention.size
}