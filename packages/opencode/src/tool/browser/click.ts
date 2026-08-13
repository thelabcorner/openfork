import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget } from "@/browser/shared"

export const Parameters = OperationInput.click

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Click an element in the visible browser. PRIMARY targeting: a snapshot ref + its snapshotVersion ({ref: \"e7\", snapshotVersion: 3}) — the host rejects stale refs with BrowserStaleRefError, so re-snapshot after the page changes. Escape hatches: a Locator ({type, value}) or raw viewport Coords ({x, y}). The response echoes the target that was ACTUALLY resolved (selector, rect, role, name, center coords) so you can self-correct if you hit the wrong element. Use the snapshot->act->re-snapshot loop.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.click,
            patterns: [permissionPattern("click")],
            always: ["*"],
            metadata: { tool: "browser_click", target: params.target },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "click",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.click,
            abort: ctx.abort,
          })
          const clicked = result.clicked
          const after = clicked.afterUrl ? ` after -> ${clicked.afterUrl} "${clicked.afterTitle ?? ""}"` : ""
          return {
            title: "Clicked browser element",
            output: `clicked ${formatTarget(clicked.target)} at (${clicked.coords.x},${clicked.coords.y}) x${clicked.clickCount}${after}`,
            metadata: { op: "click", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
