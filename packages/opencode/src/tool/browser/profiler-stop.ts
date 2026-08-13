import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.profiler_stop

export const BrowserProfilerStopTool = Tool.define(
  "browser_profiler_stop",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Stop React profiling and return the bounded report: total commit count, elapsed window ms, top-N most-rendered components with render counts, and (optionally) a props diff for a named component. Render counts are fiber-walk APPROXIMATIONS — never present them as wall-clock profiling; commit timings come from the real React DevTools commit listener. Output is bounded (200 entries / 64KB). Call browser_profiler_start first.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.profiler_stop,
            patterns: [permissionPattern("profiler_stop")],
            always: ["*"],
            metadata: { tool: "browser_profiler_stop", tabId: params.tabId },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "profiler_stop",
            input: params,
            timeoutMs: DEFAULT_TIMEOUT_MS.profiler_stop,
            abort: ctx.abort,
          })
          const profiled = result.profiled
          const lines: string[] = [`React profile: ${profiled.commits} commits over ${profiled.windowMs}ms${profiled.truncated ? " (truncated)" : ""}`]
          if (profiled.topRenders.length > 0) {
            lines.push("top renders (fiber-walk approximation, not wall-clock):")
            for (const render of profiled.topRenders) lines.push(`  ${render.name}: ${render.count}`)
          }
          if (profiled.propsDiff !== undefined) {
            lines.push(`props diff for ${profiled.propsDiff.component}:`)
            for (const prop of profiled.propsDiff.props) {
              lines.push(`  ${prop.key}: ${JSON.stringify(prop.before)} -> ${JSON.stringify(prop.after)}`)
            }
          }
          return {
            title: "Stopped browser React profiler",
            output: lines.join("\n"),
            metadata: { op: "profiler_stop", requestId, elapsedMs, commits: profiled.commits, windowMs: profiled.windowMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
