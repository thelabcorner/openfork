import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.react_inspect

export const BrowserReactInspectTool = Tool.define(
  "browser_react_inspect",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Inspect the React component behind a target element in the live browser: component name, Babel-compiled JSX source file/line (via _debugSource, available only on dev builds — Babel preserves file/line there), current props, and readable hook state (useState/useReducer values), plus a bounded ancestor-component breadcrumb. This is the agent's React DevTools: it reads React's Fiber tree directly (DOM __reactFiber$ keys, same data DevTools uses) — no React DevTools extension required, works on any page the browser already has open, and complements browser_open_devtools / browser_extensions_list / window.__REACT_DEVTOOLS_GLOBAL_HOOK__ via browser_evaluate. Only useful against a page that is actually a React app running an unminified/development build (hasReact: false and an empty component otherwise); pair with browser_profiler_start/stop for render-count profiling instead of one-shot inspection. PRIMARY targeting is a snapshot ref + snapshotVersion; locator/coords are escape hatches.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.react_inspect,
            patterns: [permissionPattern("react_inspect")],
            always: ["*"],
            metadata: { tool: "browser_react_inspect", target: params.target },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "react_inspect",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.react_inspect,
            abort: ctx.abort,
          })
          const { inspected } = result
          if (!inspected.hasReact) {
            return {
              title: "Target is not a React component",
              output: "The target element has no React Fiber attached (not a React app, or a production build with fibers stripped).",
              metadata: { op: "react_inspect", requestId, elapsedMs },
            }
          }
          const component = inspected.component
          const lines = component
            ? [
                `Component: <${component.name}>`,
                component.source ? `Source: ${component.source.file}${component.source.line != null ? `:${component.source.line}` : ""}` : undefined,
                component.props !== undefined ? `Props: ${JSON.stringify(component.props)}` : undefined,
                component.hooks && component.hooks.length > 0 ? `Hooks (${component.hooks.length}): ${JSON.stringify(component.hooks)}` : undefined,
                inspected.ancestors.length > 0 ? `Ancestors: ${inspected.ancestors.map((a) => `<${a.name}>`).join(" < ")}` : undefined,
              ].filter((line): line is string => line !== undefined)
            : ["No named component found on the fiber path from this element (likely a plain DOM node inside a component)."]
          return {
            title: component ? `Inspected <${component.name}>` : "Inspected element",
            output: lines.join("\n"),
            metadata: { op: "react_inspect", requestId, elapsedMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
