/**
 * Observe-only cohort selection for OpenFork V1's native LLM runtime.
 * All inference and permissions remain owned by the existing harness.
 */
export function laceObservePolicy(
  sessionID: string,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.OPENFORK_LACE_OBSERVE_NATIVE !== "1" || !sessionID) return false
  const raw = environment.OPENFORK_LACE_OBSERVE_EVERY
  const sampleEvery = raw === undefined ? 16 : Number(raw)
  if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 1 || sampleEvery > 1024) return false
  // Cohort by session rather than by request to preserve useful consecutive
  // prefix comparisons. No user content participates in sampling.
  let hash = 2166136261
  for (let i = 0; i < sessionID.length; i++) {
    hash = Math.imul(hash ^ sessionID.charCodeAt(i), 16777619)
  }
  return (hash >>> 0) % sampleEvery === 0
}

export function laceObserveScope(input: {
  readonly projectID: string
  readonly directory: string
  readonly worktree: string
  readonly sessionID: string
  readonly routeKind: "account" | "public"
  readonly accountID?: string
  readonly continuity: "session" | "isolated"
  readonly requestID: string
}): { readonly owner: string; readonly session: string } | undefined {
  if (!input.projectID || !input.directory || !input.worktree || !input.sessionID ||
      (input.routeKind === "account" && !input.accountID) || !input.requestID) return undefined
  return {
    owner: JSON.stringify([input.projectID, input.directory, input.worktree,
      input.routeKind, input.accountID ?? null]),
    // Isolated maintenance generations must never become an ordinary parent
    // Session cache continuation, even when sharing the same Session ID.
    session: input.continuity === "isolated"
      ? JSON.stringify([input.sessionID, input.requestID, "isolated"])
      : input.sessionID,
  }
}
