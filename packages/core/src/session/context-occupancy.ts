/**
 * Core-owned, browser-safe projection of the latest *settled* provider context.
 *
 * Schema defines the serialized input/output shape. Core owns this computation.
 * Native UI and OXP call the same pure function, without a secondary transcript
 * scan, a location bootstrap, or a distinct transport-specific implementation.
 */
import type { ContextOccupancy as Contract } from "@opencode-ai/schema/context-occupancy"

export type Footprint = Contract.Footprint
export type ContextInput = Contract.ContextInput

export function project(input: ContextInput | undefined): Footprint | undefined {
  if (!input) return undefined
  const current = input.telemetry?.context
  if (current) {
    const tokens = current.tokens
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const limit = current.model.contextLimit
    return {
      providerLabel: current.model.providerID,
      modelLabel: current.model.name ?? current.model.modelID,
      limit,
      total,
      usage: limit && limit > 0 ? Math.round((total / limit) * 100) : null,
      updatedAt: input.telemetry!.updatedAt,
    }
  }
  const latest = input.history.latest
  if (!latest) return undefined
  const total =
    latest.tokens.input +
    latest.tokens.output +
    latest.tokens.reasoning +
    latest.tokens.cacheRead +
    latest.tokens.cacheWrite
  const limit = latest.contextLimit
  return {
    providerLabel: latest.providerName || latest.providerID,
    modelLabel: latest.modelName || latest.modelID,
    limit,
    total,
    usage: limit && limit > 0 ? Math.round((total / limit) * 100) : null,
    updatedAt: latest.completedAt,
  }
}

export * as ContextOccupancy from "./context-occupancy"
