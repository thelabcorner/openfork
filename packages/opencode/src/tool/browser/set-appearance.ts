import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.set_appearance

export const BrowserSetAppearanceTool = Tool.define(
  "browser_set_appearance",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Set the browser guest's color scheme (system/light/dark). The host reports which of light/dark was actually applied. Useful before a snapshot when the theme affects element visibility.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.set_appearance,
            patterns: [permissionPattern("set_appearance")],
            always: ["*"],
            metadata: { tool: "browser_set_appearance", appearance: params.appearance },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "set_appearance",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.set_appearance,
            abort: ctx.abort,
          })
          return {
            title: "Set browser appearance",
            output: `appearance set to ${result.appearance} (effective ${result.effective})`,
            metadata: { op: "set_appearance", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
