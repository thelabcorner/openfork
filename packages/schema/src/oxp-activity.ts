export * as OxpActivity from "./oxp-activity"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const ActivityID = Schema.String.check(Schema.isStartsWith("oxpa_")).pipe(
  Schema.brand("OxpParentActivityID"),
  statics((schema) => ({
    create: () => schema.make("oxpa_" + ascending()),
  })),
)
export type ActivityID = typeof ActivityID.Type

export const InvocationID = Schema.String.check(Schema.isStartsWith("oxpi_")).pipe(
  Schema.brand("OxpInvocationID"),
  statics((schema) => ({
    create: () => schema.make("oxpi_" + ascending()),
  })),
)
export type InvocationID = typeof InvocationID.Type

export const Plane = Schema.Literals(["augmentation", "supervision", "delegation"]).annotate({
  identifier: "OxpActivity.Plane",
})
export type Plane = typeof Plane.Type

export const CorrelationScope = Schema.Literals(["unknown", "parent_session", "conversation"]).annotate({
  identifier: "OxpActivity.CorrelationScope",
})
export type CorrelationScope = typeof CorrelationScope.Type

export const Status = Schema.Literals([
  "running",
  "success",
  "committed",
  "cancelled_before_commit",
  "cancelled_after_commit",
  "denied",
  "conflict",
  "failed",
  "ambiguous_external_result",
  "interrupted",
]).annotate({ identifier: "OxpActivity.Status" })
export type Status = typeof Status.Type

export const ContinuityMarker = Schema.Literals(["handoff_advisory"]).annotate({
  identifier: "OxpActivity.ContinuityMarker",
})
export type ContinuityMarker = typeof ContinuityMarker.Type

// Durable token-attribution projections only persist observations that can be
// reproduced without a calibration model. Approximate surrogate/donor sources
// are derived by Core at read time so recalibration can never leave stale
// estimates masquerading as durable facts.
export const ContextExactSource = Schema.Literals(["observed_boundary", "historical_detail"]).annotate({
  identifier: "OxpActivity.ContextExactSource",
})
export type ContextExactSource = typeof ContextExactSource.Type

export const ContextSchema = Schema.Literals([
  "oxp-boundary-primary-text/v1",
  "oxp-primary-args-output-error/v1",
]).annotate({ identifier: "OxpActivity.ContextSchema" })
export type ContextSchema = typeof ContextSchema.Type

export const LinkKind = Schema.Literals([
  "session",
  "worker_session",
  "worker_group",
  "scheduled_task",
  "process",
  "root",
  "external_mcp",
  "file_transfer",
]).annotate({ identifier: "OxpActivity.LinkKind" })
export type LinkKind = typeof LinkKind.Type

// Live projection events only. The SQLite activity domain is authoritative;
// these carry stable identifiers so clients can invalidate compact projections
// without receiving args/results, correlation material, or history payloads.
const Created = define({
  type: "oxpActivity.created",
  schema: { activityID: ActivityID },
})
const Updated = define({
  type: "oxpActivity.updated",
  schema: { activityID: ActivityID },
})
const Removed = define({
  type: "oxpActivity.removed",
  schema: { activityID: ActivityID },
})
const InvocationStarted = define({
  type: "oxpActivity.invocation.started",
  schema: { activityID: ActivityID, invocationID: InvocationID },
})
const InvocationSettled = define({
  type: "oxpActivity.invocation.settled",
  schema: { activityID: ActivityID, invocationID: InvocationID },
})
const LinkAdded = define({
  type: "oxpActivity.link.added",
  schema: { activityID: ActivityID, invocationID: InvocationID },
})

export const Event = {
  Created,
  Updated,
  Removed,
  InvocationStarted,
  InvocationSettled,
  LinkAdded,
  Definitions: inventory(Created, Updated, Removed, InvocationStarted, InvocationSettled, LinkAdded),
} as const
