import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.annotate

export const BrowserAnnotateTool = Tool.define(
  "browser_annotate",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Draw persistent labeled annotation boxes on one or more browser targets so the user and agent can discuss visible regions. Targets use the same ref/locator/coords model as browser_click. By default this clears prior annotations before drawing; pass clear:false to layer more boxes, or targets:[] with clear:true to clear.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.annotate,
            patterns: [permissionPattern("annotate")],
            always: ["*"],
            metadata: { tool: "browser_annotate", tabId: params.tabId, count: params.targets?.length ?? 0, clear: params.clear },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "annotate",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.annotate,
            abort: ctx.abort,
          })
          return {
            title: "Annotated browser page",
            output: `annotated ${result.annotated.count} target${result.annotated.count === 1 ? "" : "s"} on tab ${result.annotated.tabId}${result.annotated.cleared ? " after clearing existing annotations" : ""}`,
            metadata: { op: "annotate", requestId, elapsedMs, count: result.annotated.count, cleared: result.annotated.cleared },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
