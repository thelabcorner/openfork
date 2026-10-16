import { Schema } from "effect"

/** Browser-safe settled native Usage analytics. Windows are [since, until) epoch milliseconds. */
export const WorkloadRequest = Schema.Struct({
  since: Schema.NumberFromString,
  until: Schema.NumberFromString,
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  projectID: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export type WorkloadRequest = {
  since: number
  until: number
  providerID?: string
  modelID?: string
  projectID?: string
  limit?: number
}

const Distribution = Schema.Struct({
  samples: Schema.Number,
  sumMs: Schema.Number,
  p50Ms: Schema.NullOr(Schema.Number),
  p95Ms: Schema.NullOr(Schema.Number),
})
const ToolCounts = Schema.Struct({
  calls: Schema.Number,
  success: Schema.Number,
  error: Schema.Number,
  abort: Schema.Number,
  denied: Schema.Number,
  timeout: Schema.Number,
  unknown: Schema.Number,
  duration: Distribution,
})
const GenerationTokens = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
})
/** Shared settlement/time/token aggregate for generation projects (totals, unattributed, and per-row). */
const GenerationProjectTotals = Schema.Struct({
  settlements: Schema.Number,
  generationMs: Schema.Number,
  /** Measured denominator: records whose generation duration was observable. */
  generationRecords: Schema.Number,
  tokens: GenerationTokens,
  /** Measured denominator: records that captured a non-zero token total. */
  tokenRecords: Schema.Number,
})
/** Tool/project row shared by the volume, failure and time boards; `topTools` is bounded. */
const ProjectToolRow = Schema.Struct({
  project: Schema.String,
  /** Display name from cheap durable metadata only; null when no name is known. */
  projectName: Schema.NullOr(Schema.String),
  ...ToolCounts.fields,
  /** Dominant tools inside this project (bounded, ranked by calls), each with full outcome counts. */
  topTools: Schema.Array(Schema.Struct({ tool: Schema.String, ...ToolCounts.fields })),
})

export const WorkloadSnapshot = Schema.Struct({
  since: Schema.Number,
  until: Schema.Number,
  providerID: Schema.NullOr(Schema.String),
  modelID: Schema.NullOr(Schema.String),
  projectID: Schema.NullOr(Schema.String),
  watermark: Schema.Struct({ generationCompletedAt: Schema.NullOr(Schema.Number), toolCompletedAt: Schema.NullOr(Schema.Number) }),
  generation: Schema.Struct({
    settlements: Schema.Number,
    quantiles: Schema.Literals(["exact", "suppressed-large-cohort"]),
    /** Host-observed dispatch -> first streamed content, not provider-internal TTFT. */
    requestToFirstToken: Distribution,
    /** Assistant creation -> first streamed content, including local setup/queueing. */
    clientToFirstToken: Distribution,
    /** First streamed content -> provider stream end. */
    streamedGeneration: Distribution,
    providerInternalTTFT: Schema.NullOr(Distribution),
  }),
  tools: Schema.Struct({
    provenance: Schema.Literals(["producer-settlement", "unavailable"]),
    coverage: Schema.Literals(["recorded-only; historical calls may be missing", "unavailable"]),
    firstRecordedAt: Schema.NullOr(Schema.Number),
    quantiles: Schema.Literals(["exact", "suppressed-large-cohort", "unavailable"]),
    totals: ToolCounts,
    rows: Schema.Array(Schema.Struct({ tool: Schema.String, ...ToolCounts.fields })),
    topFailingRows: Schema.Array(Schema.Struct({ tool: Schema.String, ...ToolCounts.fields })),
    topSlowRows: Schema.Array(Schema.Struct({ tool: Schema.String, ...ToolCounts.fields })),
    totalTools: Schema.Number,
    omittedTools: Schema.Number,
  }),
  projects: Schema.Struct({
    provenance: Schema.Literals(["producer-settlement", "unavailable"]),
    coverage: Schema.Literals(["recorded-only; historical calls may be missing", "unavailable"]),
    /** Exactness of per-project and per-tool tool-duration percentiles; the whole tool cohort shares this gate. */
    quantiles: Schema.Literals(["exact", "suppressed-large-cohort", "unavailable"]),
    /** Independent full-sum over the whole filtered cohort; never derived from the top-N rows. */
    totals: ToolCounts,
    rows: Schema.Array(ProjectToolRow),
    /** Independent tool-failure leaderboard; never derived by truncating the volume board. */
    topFailingRows: Schema.Array(ProjectToolRow),
    /** Independent cumulative tool-time leaderboard; catches low-volume expensive projects. */
    topSlowRows: Schema.Array(ProjectToolRow),
    totalProjects: Schema.Number,
    omittedProjects: Schema.Number,
  }),
  /**
   * Model-generation top projects. Unlike `projects` (which ranks native tool
   * invocations), this ranks settled model calls so tool-less models still
   * appear. Attribution reuses Inspection's session/usage_session tombstone
   * semantics; a record with no resolvable project lands in `unattributed`.
   * Rows are (project, provider, model) cohorts ranked by settled calls.
   */
  generationProjects: Schema.Struct({
    provenance: Schema.Literals(["producer-settlement", "unavailable"]),
    coverage: Schema.Literals(["recorded-only; historical calls may be missing", "unavailable"]),
    /** Independent full-sum over the whole filtered cohort; never derived from the top-N rows. */
    totals: GenerationProjectTotals,
    /** Settlements whose session/project attribution could not be resolved. */
    unattributed: GenerationProjectTotals,
    rows: Schema.Array(Schema.Struct({
      project: Schema.String,
      projectName: Schema.NullOr(Schema.String),
      providerID: Schema.String,
      modelID: Schema.String,
      ...GenerationProjectTotals.fields,
    })),
    totalProjects: Schema.Number,
    omittedProjects: Schema.Number,
  }),
})
export type WorkloadSnapshot = Schema.Schema.Type<typeof WorkloadSnapshot>

export * as UsageWorkload from "./workload"
