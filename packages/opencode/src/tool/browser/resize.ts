import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.resize

export const BrowserResizeTool = Tool.define(
  "browser_resize",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Resize the visible browser guest's CSS viewport. The returned actual width/height/dpr is the coordinate space all later click/scroll coordinates are relative to — call this before interacting if the page layout depends on viewport size.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.resize,
            patterns: [permissionPattern("resize")],
            always: ["*"],
            metadata: { tool: "browser_resize", width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "resize",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.resize,
            abort: ctx.abort,
          })
          const resized = result.resized
          return {
            title: "Resized browser viewport",
            output: `resized to ${resized.width}x${resized.height} (requested ${resized.actualWidth}x${resized.actualHeight}, dpr ${resized.dpr})`,
            metadata: { op: "resize", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
