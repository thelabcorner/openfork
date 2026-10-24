import { createHash } from "node:crypto"

/**
 * Canonical navigation ownership for workers created by an external OXP session.
 *
 * OXP ingress supplies an already pseudonymized conversation reference; the
 * display title is never part of identity. Raw ChatGPT conversation identifiers
 * are never persisted in SessionGroup. This is a pure domain projection, not a
 * Session or permission principal, and cannot confer delegation authority.
 */
export interface Origin {
  readonly principalRef: string
  readonly rootRef: string
  readonly parentSession?: {
    readonly ref: string
    readonly title?: string
  }
}

export function delegatedWorkerGroup(input: Origin) {
  // Preserve existing connector/root ownership for unattributed legacy calls.
  const ownerRef = input.parentSession
    ? `oxp-session:${input.principalRef}:${input.parentSession.ref}`
    : `${input.principalRef}:${input.rootRef}`
  const name = input.parentSession?.title ?? (input.parentSession ? "OXP session" : "OXP delegated workers")
  return {
    id: "grp_oxp_" + createHash("sha256").update(ownerRef).digest("hex"),
    ownerRef,
    name,
    // A title lookup failure must never downgrade a previously known name.
    authoritativeTitle: input.parentSession?.title !== undefined,
  }
}
