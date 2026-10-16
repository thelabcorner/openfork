import { Schema } from "effect"
import { ExternalCode } from "@/exchange/code"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  ...ExternalCode.Fields,
  rootID: Schema.optional(OxpSchema.RootID).annotate({
    description: "Approved OXP root inherited by generated leaf calls that accept rootID.",
  }),
})
export type Parameters = typeof Parameters.Type

export const DESCRIPTION =
  "Run confined JavaScript/TypeScript that discovers and composes authorized OXP and MCP capabilities through call(ref,input). Stateless search/describe/run; no ambient authority."

export * as OxpCode from "./code"
