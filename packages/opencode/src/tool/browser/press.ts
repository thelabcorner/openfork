import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget } from "@/browser/shared"

export const Parameters = OperationInput.press

export const BrowserPressTool = Tool.define(
  "browser_press",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Press a keyboard key (e.g. \"Enter\", \"Tab\", \"Escape\", \"ArrowDown\", \"Backspace\", or a letter). Optionally target an element first via snapshot ref + snapshotVersion, or a locator/coords escape hatch. The response echoes the resolved target, whether the key auto-repeated, and active modifiers.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.press,
            patterns: [permissionPattern("press")],
            always: ["*"],
            metadata: { tool: "browser_press", key: params.key, target: params.target },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "press",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.press,
            abort: ctx.abort,
          })
          const pressed = result.pressed
          const target = pressed.target ? ` on ${formatTarget(pressed.target)}` : ""
          const modifiers = pressed.modifiers.length > 0 ? ` modifiers: ${pressed.modifiers.join("+")}` : ""
          return {
            title: "Pressed browser key",
            output: `pressed ${pressed.key}${target}${pressed.repeat ? " (repeat)" : ""}${modifiers}`,
            metadata: { op: "press", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
