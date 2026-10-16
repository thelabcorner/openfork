/**
 * Browser-safe, serializable input/output contract for provider-reported
 * context occupancy. The computation belongs to
 * @opencode-ai/core/session/context-occupancy; Schema owns shapes only.
 */
export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type HistoricalTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type ContextInput = {
  readonly telemetry?: {
    readonly updatedAt: number
    readonly context?: {
      readonly model: {
        readonly providerID: string
        readonly modelID: string
        readonly name?: string
        readonly contextLimit?: number
      }
      readonly tokens: Tokens
    }
  } | null
  readonly history: {
    readonly latest?: {
      readonly providerID: string
      readonly providerName: string
      readonly modelID: string
      readonly modelName: string
      readonly completedAt: number
      readonly contextLimit?: number
      readonly tokens: HistoricalTokens
    }
  }
}

export type Footprint = {
  readonly providerLabel: string
  readonly modelLabel: string
  readonly limit: number | undefined
  readonly total: number
  readonly usage: number | null
  readonly updatedAt: number
}

export * as ContextOccupancy from "./context-occupancy"
