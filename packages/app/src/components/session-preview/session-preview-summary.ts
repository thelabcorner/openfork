import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { sessionStatusIsWorking } from "@/utils/session-status"

export interface PreviewSummary {
  running: number
  waiting: number
}

/** Keep a status-transition event with unchanged aggregate counts from
 * restarting the inspector clock or invalidating every summary text node.
 */
export function samePreviewSummary(a: PreviewSummary, b: PreviewSummary) {
  return a.running === b.running && a.waiting === b.waiting
}

/**
 * Large-group aggregate over sparse authoritative server-session maps.
 *
 * Idle sessions have no status record, so the old approach subscribed to
 * every group member's individual status, paused, permission and question
 * properties, even when 99% were idle. Here only live records are examined.
 * Waiting overrides working; duplicate group membership counts intentionally
 * retain the number of rendered relationship entries.
 */
export function previewSparseSummary(input: {
  weights: ReadonlyMap<string, number>
  statuses: Readonly<Record<string, SessionStatus | undefined>>
  paused: Readonly<Record<string, boolean | undefined>>
  permissions: Readonly<Record<string, readonly unknown[] | undefined>>
  questions: Readonly<Record<string, readonly unknown[] | undefined>>
}): PreviewSummary {
  const { weights, statuses, paused, permissions, questions } = input
  const attention = new Set<string>()
  for (const [id, requests] of Object.entries(questions)) {
    if (requests?.length && weights.has(id)) attention.add(id)
  }
  for (const [id, requests] of Object.entries(permissions)) {
    if (requests?.length && weights.has(id)) attention.add(id)
  }
  let running = 0
  let waiting = 0
  for (const id of attention) waiting += weights.get(id) ?? 0
  for (const [id, value] of Object.entries(statuses)) {
    if (attention.has(id) || !sessionStatusIsWorking(value?.type) || paused[id] === true) continue
    running += weights.get(id) ?? 0
  }
  return { running, waiting }
}