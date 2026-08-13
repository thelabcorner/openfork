import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.query

export const BrowserQueryTool = Tool.define(
  "browser_query",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Run a CSS/XPath/role query against the live page and return bounded matches (default up to 20; maxResults caps it) with their rect, center, visibility, display, computed position, and a text snippet. Use this for targeted exploration and ASSERTION — e.g. \"is the error banner visible?\", \"how many rows does this table have?\" — instead of a full snapshot. Distinct from browser_snapshot: query answers a specific question; snapshot maps the whole page.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.query,
            patterns: [permissionPattern("query")],
            always: ["*"],
            metadata: { tool: "browser_query", target: params.target, maxResults: params.maxResults },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            operation: "query",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.query,
            abort: ctx.abort,
          })
          const queried = result.queried
          const lines: string[] = [`query on tab ${queried.tabId} @ ${queried.url}: ${queried.count} match(es)${queried.truncated ? " (truncated)" : ""}`]
          for (const match of queried.matches) {
            const ref = match.ref ? ` ${match.ref}` : ""
            const role = match.role ? `<${match.role}>` : ""
            const name = match.name ? ` "${match.name}"` : ""
            const text = match.text ? ` text="${match.text.slice(0, 80)}"` : ""
            const state = `${match.visibility} (display:${match.display}, position:${match.position})`
            lines.push(`  ${ref} ${role}${name} rect(${Math.round(match.rect.x)},${Math.round(match.rect.y)} ${Math.round(match.rect.width)}x${Math.round(match.rect.height)}) center(${match.center.x},${match.center.y}) ${state}${text}`)
          }
          return {
            title: `Query matched ${queried.count} element(s)`,
            output: lines.join("\n"),
            metadata: { op: "query", requestId, elapsedMs, count: queried.count },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
