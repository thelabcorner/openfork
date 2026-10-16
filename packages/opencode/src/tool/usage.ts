import { Effect } from "effect"
import { Usage } from "@/usage/usage"
import { UsageInspectionContract } from "@/usage/inspection-contract"
import * as Tool from "./tool"
import DESCRIPTION from "./usage.txt"

export const Parameters = UsageInspectionContract.Parameters
export const runUsage = UsageInspectionContract.runUsage
export type Metadata = UsageInspectionContract.Metadata

/** Native adapter over the same domain contract used by OXP. */
export const UsageTool = Tool.define<typeof Parameters, Metadata, Usage.Service>(
  "usage",
  Effect.gen(function* () {
    const usage = yield* Usage.Service
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        runUsage(params, usage).pipe(
          Effect.mapError(
            (error: UsageInspectionContract.UsageArgumentsError) =>
              new Tool.InvalidArgumentsError({ tool: "usage", detail: error.detail }),
          ),
        ),
    }
  }),
)
