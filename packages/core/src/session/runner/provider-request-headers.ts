export * as ProviderRequestHeaders from "./provider-request-headers"

import { Flag } from "../../flag/flag"
import { OpenCodeHostedUserAgent } from "../../installation/version"

/**
 * Outbound provider request identity for one Core generation.
 *
 * This is the single Core owner of the physical hosted wire identity. It lives
 * in its own leaf module because every request class needs it, including
 * `session/title.ts`, while `session/runner/llm.ts` already imports that module
 * -- importing the helper from the runner would close a module cycle.
 *
 * Keep this pure. Hosted headers are telemetry/stickiness and provider-affinity
 * parity, never entitlement: anonymous admission is controlled separately by
 * public credential and model metadata. Nothing here may select, rebind, or
 * re-stamp a provider route, and nothing here may read credential material.
 */
export function providerRequestHeaders(input: {
  readonly providerID: string
  readonly projectID: string
  readonly sessionID: string
  readonly requestID: string
  readonly parentSessionID?: string
  readonly client?: string
}): Record<string, string> {
  const parent: Record<string, string> = input.parentSessionID
    ? { "x-parent-session-id": input.parentSessionID }
    : {}
  if (input.providerID.startsWith("opencode")) {
    return {
      "x-opencode-project": input.projectID,
      "x-opencode-session": input.sessionID,
      "x-opencode-request": input.requestID,
      "x-opencode-client": input.client ?? Flag.OPENCODE_CLIENT,
      "User-Agent": OpenCodeHostedUserAgent(),
      ...parent,
    }
  }
  return {
    "x-session-affinity": input.sessionID,
    "X-Session-Id": input.sessionID,
    ...parent,
  }
}
