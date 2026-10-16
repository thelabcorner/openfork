import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.extensions_list

export const BrowserExtensionsListTool = Tool.define(
  "browser_extensions_list",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "List extensions loaded in OpenFork's embedded browser guest session. This is not an inventory of extensions installed in your regular Chrome profile. For Chrome tabs controlled through the OpenFork companion extension, browser_profiler_start checks whether a React DevTools-compatible hook and renderer are actually connected to that page.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.extensions_list,
            patterns: [permissionPattern("extensions_list")],
            always: ["*"],
            metadata: { tool: "browser_extensions_list", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            ...(params.tabId ? { tabId: params.tabId } : {}),
            operation: "extensions_list",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.extensions_list,
            abort: ctx.abort,
          })
          const lines =
            result.extensions.length === 0
              ? ["No extensions installed in this guest session."]
              : result.extensions.map((ext) => `${ext.enabled ? "enabled" : "disabled"} ${ext.name} (${ext.id}) v${ext.version}`)
          if (result.extensions.some((ext) => ext.name.toLowerCase().includes("react") && ext.name.toLowerCase().includes("devtools"))) {
            lines.push("React DevTools is available — use browser_react_inspect or browser_evaluate with window.__REACT_DEVTOOLS_GLOBAL_HOOK__.")
          }
          return {
            title: `Extensions (${result.extensions.length})`,
            output: lines.join("\n"),
            metadata: { op: "extensions_list", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
