/**
 * Pure, provider-qualified usage drilldown navigation. Deliberately independent
 * of the provider catalog: Usage identity comes from settled usage records.
 */
export type UsageDrilldown =
  | { level: "global"; providerID: null; modelID: null }
  | { level: "provider"; providerID: string; modelID: null }
  | { level: "model"; providerID: string; modelID: string }

export const globalUsageDrilldown: UsageDrilldown = {
  level: "global", providerID: null, modelID: null,
}

export function usageProviderScope(providerID: string): UsageDrilldown {
  return providerID ? { level: "provider", providerID, modelID: null } : globalUsageDrilldown
}

export function usageModelScope(providerID: string, modelID: string): UsageDrilldown {
  if (!providerID || !modelID) return usageProviderScope(providerID)
  return { level: "model", providerID, modelID }
}

export function usageScopeTitle(scope: UsageDrilldown) {
  return scope.level === "model" ? scope.modelID : scope.level === "provider" ? scope.providerID : "All providers"
}

export function usageScopeCrumbs(scope: UsageDrilldown): { label: string; target: UsageDrilldown }[] {
  const result = [{ label: "All providers", target: globalUsageDrilldown }]
  if (scope.providerID) result.push({ label: scope.providerID, target: usageProviderScope(scope.providerID) })
  if (scope.modelID) result.push({ label: scope.modelID, target: scope })
  return result
}

/** One authoritative query shape shared by every profiling scope. */
export function usageWorkloadParams(
  scope: UsageDrilldown, since: number, until: number,
  projectID: string | null, limit = 40,
) {
  return {
    since: String(since),
    until: String(until),
    ...(scope.providerID ? { providerID: scope.providerID } : {}),
    ...(scope.modelID ? { modelID: scope.modelID } : {}),
    ...(projectID ? { projectID } : {}),
    limit,
  }
}

/** Resource loaders retain prior results while fetching; never display stale
 * provider/model/project data beneath the next cohort heading. */
export function matchesUsageWorkload(
  scope: UsageDrilldown, range: { since: number; until: number },
  projectID: string | null,
  snapshot: {
    since: number; until: number; providerID: string | null;
    modelID: string | null; projectID: string | null
  } | undefined,
) {
  return !!snapshot && snapshot.since === range.since && snapshot.until === range.until &&
    snapshot.providerID === scope.providerID && snapshot.modelID === scope.modelID &&
    snapshot.projectID === projectID
}

/** Validates a restored drilldown against settled scopes; avoids a false zero cohort. */
export function reconcileUsageDrilldown(
  scope: UsageDrilldown,
  providerIDs: readonly string[],
  models: readonly { providerID: string; modelID?: string }[],
): UsageDrilldown {
  if (!scope.providerID || !providerIDs.includes(scope.providerID)) return globalUsageDrilldown
  if (scope.modelID && !models.some((row) => row.providerID === scope.providerID && row.modelID === scope.modelID))
    return usageProviderScope(scope.providerID)
  return scope
}
