import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget } from "@/browser/shared"

export const Parameters = OperationInput.wait_for

export const BrowserWaitForTool = Tool.define(
  "browser_wait_for",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Wait until a condition becomes true in the visible browser (up to timeoutMs). Conditions: selector (a Locator), text (page text, optional visible), url (substring/regex pattern), or expression (a JS boolean expression). Alternatively pass target (snapshot ref + snapshotVersion, or a locator/coords escape hatch) with state: visible/enabled/checked/hidden/attached/detached to wait on a specific element's state. Use this after click/type before asserting results — the response reports the page url/title at the moment the condition was satisfied.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.condition === undefined && params.target === undefined) {
            throw new Error("browser_wait_for requires either condition or target")
          }
          yield* ctx.ask({
            permission: FAMILY.wait_for,
            patterns: [permissionPattern("wait_for")],
            always: ["*"],
            metadata: { tool: "browser_wait_for", condition: params.condition, target: params.target, state: params.state },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "wait_for",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.wait_for,
            abort: ctx.abort,
          })
          const waited = result.waited
          const condition = waited.condition !== undefined ? ` condition ${JSON.stringify(waited.condition)}` : ""
          const target = waited.target !== undefined ? ` target ${formatTarget(waited.target)}` : ""
          const element = waited.element !== undefined ? ` matched ${formatTarget(waited.element)}` : ""
          return {
            title: "Browser condition satisfied",
            output: `satisfied at ${new Date(waited.at.time).toISOString()} (url: ${waited.at.url}, title: "${waited.at.title}")${condition}${target}${element}`,
            metadata: { op: "wait_for", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
