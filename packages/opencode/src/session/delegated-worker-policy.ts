export interface TurnPolicy {
  readonly nestedDelegation: boolean
}

const KEY = "workerDelegationPolicy"

export function turnMetadata(policy: TurnPolicy): Record<string, unknown> {
  return {
    [KEY]: {
      version: 1,
      nestedDelegation: policy.nestedDelegation,
    },
  }
}

export function turnPolicy(
  metadata: Readonly<Record<string, unknown>> | undefined,
): TurnPolicy | undefined {
  const raw = metadata?.[KEY]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const row = raw as Record<string, unknown>
  if (row.version !== 1 || typeof row.nestedDelegation !== "boolean") return
  return { nestedDelegation: row.nestedDelegation }
}

export * as DelegatedWorkerPolicy from "./delegated-worker-policy"
