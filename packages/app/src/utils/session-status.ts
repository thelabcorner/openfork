import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

/** Whether the session has a live execution or a scheduled provider retry. */
export function sessionStatusIsWorking(status: SessionStatus["type"] | undefined) {
  return status === "busy" || status === "retry"
}
