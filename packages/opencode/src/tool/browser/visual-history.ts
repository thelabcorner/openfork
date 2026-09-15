import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.visual_history

export const BrowserVisualHistoryTool = Tool.define(
  "browser_visual_history",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "List deterministic SnapEye baselines and completed visual runs for the current project. This is project-scoped and does not require a browser tab. Returns only bounded metadata and project-relative .snapeye paths; it never streams image/video bytes into model context.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.visual_history,
            patterns: [permissionPattern("visual_history")],
            always: ["*"],
            metadata: { tool: "browser_visual_history", maxRuns: params.maxRuns, maxBaselines: params.maxBaselines },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "visual_history",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.visual_history,
            abort: ctx.abort,
          })
          const history = result.history
          const changed = history.runs.filter((run) => run.changed === true).length
          const recordings = history.runs.filter((run) => run.operation === "record").length
          return {
            title: "Visual history",
            output: `${history.baselines.length} visual baseline(s), ${history.runs.length} completed run(s) (${changed} changed diff(s), ${recordings} recording(s)) under ${history.root}`,
            metadata: { op: "visual_history", requestId, elapsedMs, history },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
