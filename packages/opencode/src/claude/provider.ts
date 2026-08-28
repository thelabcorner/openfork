// First-party `claude` subscription provider adapter.
// Discovery is pure/static: no SDK load, no CLI spawn, no network call.
// Setup/unavailable states are explicit and distinguishable from network errors.

import { Effect, Schema } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ClaudeModels, PROVIDER_ID, MODEL_IDS, MODEL_METADATA, ClaudeModelStatus, resolveAlias } from "./models"

export const ProviderStatus = Schema.Literals(["available", "unavailable", "setup-required", "approval-required"])
export type ProviderStatus = typeof ProviderStatus.Type

export interface DiscoveryResult {
  readonly providerID: ProviderV2.ID
  readonly status: ProviderStatus
  readonly models: Record<string, { id: string; name: string; status: ClaudeModelStatus }>
  readonly setupState?: {
    readonly executableDetected: boolean
    readonly cliAuthStatus: "unknown" | "authenticated" | "not-authenticated" | "expired"
    readonly requiresApproval: boolean
  }
  readonly errorCategory?: "setup" | "auth" | "runtime" | "network" | "none"
}

// Pure discovery: zero process side effects. No SDK import, no CLI spawn.
export function discoverPure(): DiscoveryResult {
  const models: Record<string, { id: string; name: string; status: ClaudeModelStatus }> = {}
  for (const id of MODEL_IDS) {
    const meta = MODEL_METADATA[id]
    if (!meta) continue
    models[id] = {
      id,
      name: meta.name,
      status: meta.status,
    }
  }

  // Setup state is advisory only; it does not trigger CLI/auth work.
  const setupState = {
    executableDetected: false,
    cliAuthStatus: "unknown" as const,
    requiresApproval: false,
  }

  return {
    providerID: PROVIDER_ID,
    status: "unavailable",
    models,
    setupState,
    errorCategory: "setup",
  }
}

// Typed interface suitable for fake fixtures (tests, mocks, fixtures).
export interface ClaudeProviderContract {
  readonly discover: () => DiscoveryResult
  readonly resolveAlias: (alias: string) => string | undefined
  readonly modelStatus: (modelID: string) => ClaudeModelStatus | undefined
  readonly providerStatus: () => ProviderStatus
}

export const contract: ClaudeProviderContract = {
  discover: discoverPure,
  resolveAlias,
  modelStatus: (modelID: string) => MODEL_METADATA[modelID]?.status ?? undefined,
  providerStatus: () => "unavailable",
}

// `claude/<model>` references resolve to canonical IDs. `claude-code` remains
// reserved for the external @openchamber/opencode-claude plugin.
export function migrateLegacyReference(ref: string): string | undefined {
  const alias = resolveAlias(ref)
  if (alias) return alias
  // If the reference is already a canonical model ID, return it.
  if (MODEL_IDS.includes(ref)) return ref
  return undefined
}

export * as ClaudeProvider from "./provider"
