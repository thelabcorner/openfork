import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.close

export const BrowserCloseTool = Tool.define(
  "browser_close",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Close a browser tab owned by this session (default the session's active owned tab; an explicit tabId must be this session's own tab). The user can always close any tab from the UI. Re-open with browser_open when needed.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.close,
            patterns: [permissionPattern("close")],
            always: ["*"],
            metadata: { tool: "browser_close", tabId: params.tabId, closeWindow: params.closeWindow },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "close",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.close,
            abort: ctx.abort,
          })
          const closed = result.closed
          return {
            title: "Closed browser tab",
            output: `closed tab ${closed.tabId}${closed.wasActive ? " (was active)" : ""}; ${closed.guestsRemaining} guest(s) remain${params.closeWindow ? " and window closed" : ""}`,
            metadata: { op: "close", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
