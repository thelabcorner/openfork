export type InspectionResolution = "hour" | "day"
export type InspectionDimension = "provider" | "model" | "variant" | "project"
export type InspectionMetric = "cost" | "tokens" | "messages"

export type InspectionRange = {
  readonly since: number
  readonly until: number
  readonly projectID?: string | null
}

export type InspectionTokens = {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

export type InspectionTotals = {
  readonly sessions: number
  readonly messages: number
  readonly cost: number
  readonly estimatedCost: number
  readonly pricedRecords: number
  readonly unpricedRecords: number
  readonly tokens: InspectionTokens
  readonly durationMs: number
  readonly durationRecords: number
  readonly ttftMs: number
  readonly ttftRecords: number
}

export type InspectionRates = {
  readonly tokensPerSecond: number
  readonly avgTokensPerTurn: number
  readonly avgCostPerTurn: number
  readonly cacheHitRate: number
  readonly cacheSavings: number
  readonly cacheSavingsCoverage: number
}

export type InspectionPricing = {
  readonly coverage: number
  readonly mode: "recorded" | "estimated" | "mixed" | "unpriced"
}

export type InspectionModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly messages: number
  readonly cost: number
  readonly share: number
}

export type InspectionTotalsResult = InspectionRange & {
  readonly action: "totals"
  readonly totals: InspectionTotals
  readonly rates: InspectionRates
  readonly pricing: InspectionPricing
  readonly mostUsedModel: InspectionModelRef | null
}

export type InspectionBreakdownRow = {
  readonly key: string
  readonly label: string
  readonly providerID?: string
  readonly modelID?: string
  readonly variant?: string | null
  readonly projectID?: string
  readonly messages: number
  readonly sessions: number
  readonly cost: number
  readonly estimatedCost: number
  readonly unpricedRecords: number
  readonly tokens: number
  readonly cacheSavings: number
}

export type InspectionBreakdownResult = InspectionRange & {
  readonly action: "breakdown"
  readonly dimension: InspectionDimension
  readonly rows: readonly InspectionBreakdownRow[]
  readonly totalRows: number
  readonly truncated: boolean
}

export type InspectionTimelinePoint = {
  readonly start: number
  readonly messages: number
  readonly cost: number
  readonly estimatedCost: number
  readonly tokens: number
}

export type InspectionTimelineResult = InspectionRange & {
  readonly action: "timeline"
  readonly resolution: InspectionResolution
  readonly metric: InspectionMetric
  readonly points: readonly InspectionTimelinePoint[]
  readonly sourcePoints: number
  readonly truncated: boolean
}

export type InspectionMaintenanceRow = {
  readonly key: string
  readonly label: string
  readonly agent?: string
  readonly providerID?: string
  readonly modelID?: string
  readonly requests: number
  readonly sessions: number
  readonly cost: number
  readonly estimatedCost: number
  readonly tokens: number
}

export type InspectionMaintenanceResult = InspectionRange & {
  readonly action: "maintenance"
  readonly dimension: "agent" | "model"
  readonly totals: {
    readonly requests: number
    readonly sessions: number
    readonly cost: number
    readonly estimatedCost: number
    readonly pricedRecords: number
    readonly estimatedRecords: number
    readonly unpricedRecords: number
    readonly tokens: InspectionTokens
    readonly totalTokens: number
    readonly durationMs: number
    readonly durationRecords: number
  }
  readonly rows: readonly InspectionMaintenanceRow[]
  readonly totalRows: number
  readonly truncated: boolean
}

export type UsageInspectionRequest =
  | (InspectionRange & { readonly action: "totals" })
  | (InspectionRange & {
      readonly action: "breakdown"
      readonly dimension: InspectionDimension
      readonly limit: number
      readonly sort: "cost" | "tokens" | "messages"
    })
  | (InspectionRange & {
      readonly action: "timeline"
      readonly resolution: InspectionResolution
      readonly metric: InspectionMetric
      readonly maxPoints: number
    })
  | (InspectionRange & {
      readonly action: "maintenance"
      readonly dimension: "agent" | "model"
      readonly limit: number
    })

export type UsageInspectionResult =
  | InspectionTotalsResult
  | InspectionBreakdownResult
  | InspectionTimelineResult
  | InspectionMaintenanceResult
