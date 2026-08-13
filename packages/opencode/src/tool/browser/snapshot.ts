import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrokerClient } from "@/browser/broker-client"
import { DEFAULT_TIMEOUT_MS, FAMILY, OperationInput, permissionPattern, formatViewport } from "@/browser/shared"

export const Parameters = OperationInput.snapshot

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    const broker = yield* BrokerClient.Service
    return {
      description:
        "Snapshot the visible browser page. Returns a NEW snapshotVersion, the accessibility tree (tree), a flat list of interactive elements (elements) each with a numbered ref (e1..eN), a replayable selector with confidence (high/med/low), a rect, a center point, and state flags (visible/enabled/checked/focused/readonly), plus page text and the viewport.\n\nTARGETING LOOP: 1) snapshot -> 2) act on an element by its ref with the SAME snapshotVersion ({ref: \"e7\", snapshotVersion}) via browser_click/type/press/scroll/wait_for -> 3) if the page changed, refs go stale and the host rejects them with BrowserStaleRefError — re-snapshot, never reuse old refs. Coords/locators remain valid escape hatches. The snapshot is bounded (200 elements / 20k text); use maxDepth/includeHidden/format to narrow. After any navigation, always re-snapshot.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: FAMILY.snapshot,
            patterns: [permissionPattern("snapshot")],
            always: ["*"],
            metadata: { tool: "browser_snapshot", tabId: params.tabId, maxDepth: params.maxDepth, format: params.format },
          })
          const { result, requestId, elapsedMs } = yield* broker.run({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolCallID: ctx.callID,
            tabId: params.tabId,
            operation: "snapshot",
            input: params,
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS.snapshot,
            abort: ctx.abort,
          })
          const snapshot = result.snapshot
          const lines: string[] = []
          lines.push(`snapshot v${snapshot.snapshotVersion} of tab ${snapshot.tabId} @ ${snapshot.url} (${formatViewport(snapshot.viewport)})${snapshot.truncated ? " — TRUNCATED" : ""}`)
          lines.push(`interactive elements (${snapshot.elements.length}):`)
          for (const element of snapshot.elements) {
            const state = [
              element.state.visible ? "visible" : "hidden",
              element.state.enabled ? "enabled" : "disabled",
              element.state.checked ? "checked" : "",
              element.state.focused ? "focused" : "",
              element.state.readonly ? "readonly" : "",
            ]
              .filter(Boolean)
              .join(",")
            const center = `center(${element.center.x},${element.center.y})`
            const selector = `[${element.selector.kind}:${element.selector.confidence}] ${element.selector.value}`
            lines.push(`  ${element.ref} <${element.role}> "${element.name}" ${selector} rect(${Math.round(element.rect.x)},${Math.round(element.rect.y)} ${Math.round(element.rect.width)}x${Math.round(element.rect.height)}) ${center} ${state}`)
          }
          if (snapshot.count > snapshot.elements.length) lines.push(`(${snapshot.count} total nodes; tree has ${snapshot.tree.length} roots — use maxDepth to expand)`)
          if (snapshot.text.length > 0) lines.push(`page text (${snapshot.text.length} chars):\n${snapshot.text.slice(0, 2000)}${snapshot.text.length > 2000 ? "…" : ""}`)
          return {
            title: `Snapshot of ${snapshot.url}`,
            output: lines.join("\n"),
            metadata: { op: "snapshot", requestId, elapsedMs, snapshotVersion: snapshot.snapshotVersion },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
