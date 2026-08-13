import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget, formatViewport } from "@/browser/shared"

export const Parameters = OperationInput.scroll

export const BrowserScrollTool = Tool.define(
  "browser_scroll",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Scroll the page or a targeted element. Use delta {x, y} for a relative scroll (positive y = down), or to: \"top\"/\"bottom\" for the page extremes (\"start\"/\"end\" scroll a targeted element). Optionally target an element via snapshot ref + snapshotVersion, or a locator/coords escape hatch. The response returns the new viewport including scrollX/scrollY.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.scroll,
            patterns: [permissionPattern("scroll")],
            always: ["*"],
            metadata: { tool: "browser_scroll", target: params.target, delta: params.delta, to: params.to },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "scroll",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.scroll,
            abort: ctx.abort,
          })
          const scrolled = result.scrolled
          const target = scrolled.target ? ` ${formatTarget(scrolled.target)}` : ""
          return {
            title: "Scrolled browser",
            output: `scrolled${target}; viewport now ${formatViewport(scrolled.viewport)}`,
            metadata: { op: "scroll", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
