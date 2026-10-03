export * as OxpActivitySchema from "./schema"

import { OxpActivity } from "@opencode-ai/schema/oxp-activity"

export const ActivityID = OxpActivity.ActivityID
export type ActivityID = typeof ActivityID.Type

export const InvocationID = OxpActivity.InvocationID
export type InvocationID = typeof InvocationID.Type

export const nextActivityID = () => ActivityID.create()
export const nextInvocationID = () => InvocationID.create()

export const Plane = OxpActivity.Plane
export type Plane = typeof Plane.Type

export const CorrelationScope = OxpActivity.CorrelationScope
export type CorrelationScope = typeof CorrelationScope.Type

export const Status = OxpActivity.Status
export type Status = typeof Status.Type

export const ContinuityMarker = OxpActivity.ContinuityMarker
export type ContinuityMarker = typeof ContinuityMarker.Type

export const ContextExactSource = OxpActivity.ContextExactSource
export type ContextExactSource = typeof ContextExactSource.Type

export const ContextSchema = OxpActivity.ContextSchema
export type ContextSchema = typeof ContextSchema.Type

export const LinkKind = OxpActivity.LinkKind
export type LinkKind = typeof LinkKind.Type

export type SafeSummary = Readonly<Record<string, unknown>>
export type InvocationDetail = Readonly<Record<string, unknown>>

