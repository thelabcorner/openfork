import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget } from "@/browser/shared"

export const Parameters = OperationInput.highlight

export const BrowserHighlightTool = Tool.define(
  "browser_highlight",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Flash a brief outline + badge on a target element in the visible browser so the agent and the user agree on what will be acted on. PRIMARY targeting is a snapshot ref + snapshotVersion (stale refs fail with BrowserStaleRefError); locator/coords are escape hatches. The response echoes the resolved target. Use before browser_click when the page is ambiguous or the user should see the intended target.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.highlight,
            patterns: [permissionPattern("highlight")],
            always: ["*"],
            metadata: { tool: "browser_highlight", target: params.target, durationMs: params.durationMs },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "highlight",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.highlight,
            abort: ctx.abort,
          })
          return {
            title: "Highlighted browser element",
            output: `highlighted ${formatTarget(result.highlighted.target)} at ${new Date(result.highlighted.at.time).toISOString()}`,
            metadata: { op: "highlight", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
