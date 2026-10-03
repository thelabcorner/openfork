/**
 * Fork-owned builtin tool exposure policy.
 *
 * Keep this pure: provider/session adapters and OXP both consume it, but it
 * must never depend on Tool.Context, InstanceState, or a runtime service.
 */
export const BUILTIN_LAZY_TOOL_IDS = Object.freeze([
  "archive",
  "checkpoint",
  "json",
  "refactor",
  "sqlite",
  "swarm",
  "sympy",
  "test",
] as const)

const lazy = new Set<string>(BUILTIN_LAZY_TOOL_IDS)

export type BuiltinLoadPolicy = "default" | "lazy"

export function loadPolicy(id: string): BuiltinLoadPolicy {
  return lazy.has(id) ? "lazy" : "default"
}

export function lazyExposure(id: string): "lazy" | undefined {
  return lazy.has(id) ? "lazy" : undefined
}

export * as ToolExposure from "./exposure"
