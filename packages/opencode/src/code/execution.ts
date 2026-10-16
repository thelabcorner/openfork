import { CodeMode } from "@opencode-ai/codemode"
import type * as Tool from "@/tool/tool"
import { CAPABILITY_INVOCATION_LIMITS } from "@/session/capability-invocation-limits"

const BUDGET_KEY = "__openforkCodeExecutionBudget"
const VERIFIED_SAVED_KEY = "__openforkVerifiedSavedPrograms"

export const HOST_LIMITS = {
  timeoutMs: 120_000,
  maxToolCalls: CAPABILITY_INVOCATION_LIMITS.maxCalls,
  maxOutputBytes: 120_000,
  maxIntermediateLeafBytes: 2 * 1024 * 1024,
  maxIntermediateAggregateBytes: 8 * 1024 * 1024,
  maxOperations: 1_000_000,
  maxStringBytes: 2 * 1024 * 1024,
  maxCollectionEntries: 100_000,
  maxConcurrency: CAPABILITY_INVOCATION_LIMITS.maxConcurrency,
} as const

export function createRootBudget() {
  return CodeMode.createExecutionBudget(HOST_LIMITS)
}

export function withBudget(ctx: Tool.Context, budget: CodeMode.ExecutionBudget): Tool.Context {
  const verifiedSaved =
    ctx.extra?.[VERIFIED_SAVED_KEY] instanceof Map
      ? ctx.extra[VERIFIED_SAVED_KEY]
      : new Map<string, unknown>()
  return {
    ...ctx,
    extra: {
      ...ctx.extra,
      [BUDGET_KEY]: budget,
      [VERIFIED_SAVED_KEY]: verifiedSaved,
    },
  }
}

export function budgetFrom(ctx: Tool.Context): CodeMode.ExecutionBudget | undefined {
  const value = ctx.extra?.[BUDGET_KEY]
  if (!value || typeof value !== "object") return undefined
  return value as CodeMode.ExecutionBudget
}

/** Root-local verified saved-artifact cache. Never shared across Code roots. */
export function verifiedSavedFrom(ctx: Tool.Context): Map<string, unknown> | undefined {
  const value = ctx.extra?.[VERIFIED_SAVED_KEY]
  return value instanceof Map ? value : undefined
}
