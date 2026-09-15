import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern } from "@/browser/shared"

export const Parameters = OperationInput.visual_diff

type VisualDiffMetadata = {
  [key: string]: unknown
  op: "visual_diff"
  requestId: string
  elapsedMs: number
  runId: string
  status: "ok" | "error"
}

export const BrowserVisualDiffTool = Tool.define(
  "browser_visual_diff",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Compare the current deterministic SnapEye render against a named project baseline. Returns the compact semantic verdict first: changed, changedRatio, and bounded CSS-pixel change regions. Images remain as .snapeye run artifacts and are not placed in model context. Target defaults to the document and also accepts CSS or {kind:'element',target:<snapshot ref/locator/coords>}. The redaction policy must match the captured baseline. A missing/incompatible baseline is an explicit SnapEye error, never silently accepted.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.visual_diff,
            patterns: [permissionPattern("visual_diff")],
            always: ["*"],
            metadata: { tool: "browser_visual_diff", name: params.name, target: params.target },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "visual_diff",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.visual_diff,
            abort: ctx.abort,
          })
          const visual = result.visual
          const metadata: VisualDiffMetadata = visual.status === "error"
            ? { op: "visual_diff", requestId, elapsedMs, runId: visual.runId, status: "error", error: visual.error }
            : {
                op: "visual_diff",
                requestId,
                elapsedMs,
                runId: visual.runId,
                status: "ok",
                name: visual.name,
                diff: visual.diff,
                image: visual.image,
                timing: visual.timing,
                artifacts: visual.artifacts,
                environment: visual.opencode,
              }
          if (visual.status === "error") {
            return {
              title: `Visual diff failed: ${params.name}`,
              output: `SnapEye diff failed (${visual.error.code}): ${visual.error.message}`,
              metadata,
            }
          }
          const diff = visual.diff
          const verdict = diff.changed
            ? `changed (${(diff.changedRatio * 100).toFixed(4)}%, ${diff.regionCount} region${diff.regionCount === 1 ? "" : "s"}${diff.regionsTruncated ? ", aggregated" : ""})`
            : "unchanged"
          return {
            title: `Visual diff: ${params.name} — ${verdict}`,
            output: `SnapEye ${params.name}: ${verdict}. run=${visual.runId}; regions=${JSON.stringify(diff.regions)}`,
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
