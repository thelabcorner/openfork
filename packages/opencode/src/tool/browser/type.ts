import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatTarget } from "@/browser/shared"

export const Parameters = OperationInput.type

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Type or append text into an input, textarea, or contenteditable (e.g. prompt fields). Defaults to appending to existing content; pass clear:true to replace. Uses snapshot ref for reliable targeting (re-snapshot after changes to avoid stale refs). Response shows resolved target, final value, caret position, and submit status.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.type,
            patterns: [permissionPattern("type")],
            always: ["*"],
            metadata: { tool: "browser_type", text: params.text, target: params.target, clear: params.clear, submit: params.submit },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "type",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.type,
            abort: ctx.abort,
          })
          const typed = result.typed
          const target = typed.target ? ` into ${formatTarget(typed.target)}` : " into focused element"
          const caret = `caret ${typed.caret.selectionStart}..${typed.caret.selectionEnd}`
          return {
            title: "Typed into browser",
            output: `typed "${typed.value}"${target} ${caret}${typed.submitted ? " [Enter submitted]" : ""}`,
            metadata: { op: "type", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
