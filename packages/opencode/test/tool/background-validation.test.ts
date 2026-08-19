import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { describe, expect } from "bun:test"
import type { Tool } from "../../src/tool/tool"
import { BackgroundTool } from "../../src/tool/background"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask" | "extra"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

describe("tool.background validation", () => {
  it.instance("guides when action is missing instead of leaking a raw SchemaError", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      })).find((t) => t.id === BackgroundTool.id)
      if (!tool) throw new Error("background tool not found")

      const ctx: Tool.Context = {
        ...baseCtx,
        extra: {},
        ask: (_req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.void,
      }

      // The common miss: calling with bash-style params, no action.
      const exit = yield* tool.execute({ command: "ls", workdir: "/tmp" } as never, ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const err = exit.cause
        const msg = err instanceof Error ? err.message : String(err)
        // Raw SchemaError would be "Missing key at [\"action\"]" with no guidance.
        expect(msg).not.toContain('Missing key')
        expect(msg).toContain("`background` tool manages jobs")
        expect(msg).toContain("background: true")
        expect(msg).toContain("action")
        expect(msg).toContain("background({ action: \"list\" })")
      }
    }),
  )
})
