import { Effect, Schema } from "effect"
import { Plugin } from "@/plugin"
import { BrokerClient } from "@/browser/broker-client"
import { Agent } from "@/agent/agent"
import { ToolJsonSchema } from "./json-schema"
import * as Truncate from "./truncate"
import * as Tool from "./tool"
import { BrowserStatusTool } from "./browser/status"
import { BrowserOpenTool } from "./browser/open"
import { BrowserClaimTool } from "./browser/claim"
import { BrowserNavigateTool } from "./browser/navigate"
import { BrowserResizeTool } from "./browser/resize"
import { BrowserSetAppearanceTool } from "./browser/set-appearance"
import { BrowserSnapshotTool } from "./browser/snapshot"
import { BrowserScreenshotTool } from "./browser/screenshot"
import { BrowserClickTool } from "./browser/click"
import { BrowserTypeTool } from "./browser/type"
import { BrowserPressTool } from "./browser/press"
import { BrowserScrollTool } from "./browser/scroll"
import { BrowserEvaluateTool } from "./browser/evaluate"
import { BrowserWaitForTool } from "./browser/wait-for"
import { BrowserRecordingStartTool } from "./browser/recording-start"
import { BrowserRecordingStopTool } from "./browser/recording-stop"
import { BrowserCloseTool } from "./browser/close"
import { BrowserQueryTool } from "./browser/query"
import { BrowserHighlightTool } from "./browser/highlight"
import { BrowserAnnotateTool } from "./browser/annotate"
import { BrowserProfilerStartTool } from "./browser/profiler-start"
import { BrowserProfilerStopTool } from "./browser/profiler-stop"
import { BrowserReactInspectTool } from "./browser/react-inspect"
import { BrowserOpenDevtoolsTool } from "./browser/open-devtools"
import { BrowserExtensionsListTool } from "./browser/extensions-list"
import { normalizeBrokerArgs, withObjectBrokerArgsSchema } from "./broker-args"

const OPERATIONS = [
  "status",
  "open",
  "claim",
  "navigate",
  "resize",
  "set_appearance",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "wait_for",
  "recording_start",
  "recording_stop",
  "close",
  "query",
  "highlight",
  "annotate",
  "profiler_start",
  "profiler_stop",
  "react_inspect",
  "open_devtools",
  "extensions_list",
] as const

type Operation = (typeof OPERATIONS)[number]

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "describe", "call"]).annotate({
    description:
      "list browser operations, describe one operation's exact schema, or call an operation. Use describe only when the operation arguments are not already known.",
  }),
  operation: Schema.optional(Schema.Literals(OPERATIONS)).annotate({
    description: "Browser operation for describe/call.",
  }),
  args: Schema.optional(Schema.Unknown).annotate({
    description:
      "Arguments for action=call. Pass a JSON object matching the selected operation schema. Omit only for operations with no required arguments; never pass describe output or placeholder text as args.",
  }),
})

const ProviderParameters = withObjectBrokerArgsSchema(ToolJsonSchema.fromSchema(Parameters))

type Metadata = {
  browserAction: "list" | "describe" | "call"
  operation?: Operation
  delegatedTool?: string
  [key: string]: unknown
}

const OPERATION_GROUPS: ReadonlyArray<readonly [string, readonly Operation[]]> = [
  ["read", ["status", "snapshot", "screenshot", "query", "profiler_start", "profiler_stop", "react_inspect", "extensions_list"]],
  ["navigate", ["open", "claim", "navigate", "close"]],
  ["interact", ["resize", "set_appearance", "click", "type", "press", "scroll", "wait_for", "highlight", "annotate"]],
  ["evaluate", ["evaluate", "open_devtools"]],
  ["record", ["recording_start", "recording_stop"]],
]

function requireOperation(operation: Operation | undefined, action: "describe" | "call"): Operation {
  if (operation) return operation
  throw new Error(`operation is required for browser action=${action}`)
}

function modelDescription(text: string) {
  return text.replace(/\bbrowser_([a-z_]+)\b/g, (_match, operation: string) => `browser operation "${operation}"`)
}

export const BrowserTool = Tool.define<
  typeof Parameters,
  Metadata,
  Plugin.Service | BrokerClient.Service | Agent.Service | Truncate.Service
>(
  "browser",
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service

    // Keep the mature per-operation implementations as the execution layer.
    // Only this broker is provider-visible; delegated tools retain their own
    // validation, permissions, formatting, attachments, and broker behavior.
    const infos = yield* Effect.all({
      status: BrowserStatusTool,
      open: BrowserOpenTool,
      claim: BrowserClaimTool,
      navigate: BrowserNavigateTool,
      resize: BrowserResizeTool,
      set_appearance: BrowserSetAppearanceTool,
      snapshot: BrowserSnapshotTool,
      screenshot: BrowserScreenshotTool,
      click: BrowserClickTool,
      type: BrowserTypeTool,
      press: BrowserPressTool,
      scroll: BrowserScrollTool,
      evaluate: BrowserEvaluateTool,
      wait_for: BrowserWaitForTool,
      recording_start: BrowserRecordingStartTool,
      recording_stop: BrowserRecordingStopTool,
      close: BrowserCloseTool,
      query: BrowserQueryTool,
      highlight: BrowserHighlightTool,
      annotate: BrowserAnnotateTool,
      profiler_start: BrowserProfilerStartTool,
      profiler_stop: BrowserProfilerStopTool,
      react_inspect: BrowserReactInspectTool,
      open_devtools: BrowserOpenDevtoolsTool,
      extensions_list: BrowserExtensionsListTool,
    })

    const catalog = yield* Effect.all({
      status: Tool.init(infos.status),
      open: Tool.init(infos.open),
      claim: Tool.init(infos.claim),
      navigate: Tool.init(infos.navigate),
      resize: Tool.init(infos.resize),
      set_appearance: Tool.init(infos.set_appearance),
      snapshot: Tool.init(infos.snapshot),
      screenshot: Tool.init(infos.screenshot),
      click: Tool.init(infos.click),
      type: Tool.init(infos.type),
      press: Tool.init(infos.press),
      scroll: Tool.init(infos.scroll),
      evaluate: Tool.init(infos.evaluate),
      wait_for: Tool.init(infos.wait_for),
      recording_start: Tool.init(infos.recording_start),
      recording_stop: Tool.init(infos.recording_stop),
      close: Tool.init(infos.close),
      query: Tool.init(infos.query),
      highlight: Tool.init(infos.highlight),
      annotate: Tool.init(infos.annotate),
      profiler_start: Tool.init(infos.profiler_start),
      profiler_stop: Tool.init(infos.profiler_stop),
      react_inspect: Tool.init(infos.react_inspect),
      open_devtools: Tool.init(infos.open_devtools),
      extensions_list: Tool.init(infos.extensions_list),
    })

    return {
      description:
        "One compact gateway for Desktop browser control. Operations: status, open, claim, navigate, resize, set_appearance, snapshot, screenshot, click, type, press, scroll, evaluate, wait_for, recording_start, recording_stop, close, query, highlight, annotate, profiler_start, profiler_stop, react_inspect, open_devtools, extensions_list. Use action=list for grouped discovery, action=describe for one operation's exact argument schema, and action=call to execute it. Legacy result text may say browser_open/browser_snapshot/etc.; treat those names as the corresponding operation through this tool.",
      parameters: Parameters,
      jsonSchema: ProviderParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const output = [
              "Browser operations:",
              ...OPERATION_GROUPS.map(([group, operations]) => `- ${group}: ${operations.join(", ")}`),
              "Use action=describe with one operation when you need its exact args schema; otherwise call it directly.",
            ].join("\n")
            return {
              title: "Browser operations",
              output,
              metadata: { browserAction: "list" as const },
            }
          }

          const operation = requireOperation(params.operation, params.action)
          const target = catalog[operation] as Tool.Def

          if (params.action === "describe") {
            return {
              title: `Describe browser ${operation}`,
              output: JSON.stringify(
                {
                  operation,
                  description: modelDescription(target.description),
                  args: ToolJsonSchema.fromTool(target),
                  usage: `Call browser again with action="call", operation="${operation}", and args set to a JSON object whose fields satisfy the args schema above. Do not pass the schema itself or placeholder text as args.`,
                },
                null,
                2,
              ),
              metadata: { browserAction: "describe" as const, operation, delegatedTool: target.id },
            }
          }

          const args = normalizeBrokerArgs(params.args, { broker: "browser", allowOmitted: true })
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID },
            { args },
          )
          const result = yield* target.execute(args, ctx)
          const output = {
            ...result,
            metadata: {
              ...result.metadata,
              browserAction: "call" as const,
              operation,
              delegatedTool: target.id,
            },
          }
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
            output,
          )
          return output
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Browser from "./browser"
