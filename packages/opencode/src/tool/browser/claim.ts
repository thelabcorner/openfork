import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, formatOwner, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.claim

export const BrowserClaimTool = Tool.define(
  "browser_claim",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Claim a user-owned browser tab (tabId) for this session — ownership flips to this session and the change is visible to the user. First-come-wins: if another agent already owns the tab (or claims it first), this fails with BrowserPermissionDenied. Read browser_status to see each tab's owner before claiming.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.claim,
            patterns: [permissionPattern("claim")],
            always: ["*"],
            metadata: { tool: "browser_claim", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "claim",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.claim,
            abort: ctx.abort,
          })
          const claimed = result.claimed
          return {
            title: "Claimed browser tab",
            output: `claimed tab ${claimed.tabId} for this session (owner now ${formatOwner(claimed.owner)})`,
            metadata: { op: "claim", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
