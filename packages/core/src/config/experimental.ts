export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  disable_paste_summary: Schema.optional(Schema.Boolean),
  batch_tool: Schema.optional(Schema.Boolean),
  openTelemetry: Schema.optional(Schema.Boolean),
  primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  continue_loop_on_deny: Schema.optional(Schema.Boolean),
  mcp_timeout: Schema.optional(Schema.Number),
  policies: Policy.pipe(Schema.Array, Schema.optional),
  spad_recovery: Schema.optional(Schema.Boolean),
  spad_observe_only: Schema.optional(Schema.Boolean),
}) {}
