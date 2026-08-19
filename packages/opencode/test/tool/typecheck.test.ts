import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { TypecheckTool } from "../../src/tool/typecheck"
import { parseDiagnostics, clusterDiagnostics } from "../../src/tool/typecheck-scope"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    ctx: {
      ...baseCtx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

const write = (dir: string, name: string, content: string) => Effect.promise(() => Bun.write(path.join(dir, name), content))

describe("typecheck-scope diagnostics parser (pure)", () => {
  test("parses diagnostic lines with continuation lines", () => {
    const output = [
      "src/foo.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from property 'count'",
      "src/bar.ts(1,1): error TS2304: Cannot find name 'x'.",
    ].join("\n")
    const diags = parseDiagnostics(output, 80)
    expect(diags).toHaveLength(2)
    expect(diags[0]!.code).toBe(2322)
    expect(diags[0]!.file).toBe("src/foo.ts")
    expect(diags[0]!.line).toBe(3)
    expect(diags[0]!.column).toBe(5)
    expect(diags[0]!.category).toBe("type-mismatch")
    expect(diags[0]!.severity).toBe("P1")
    expect(diags[0]!.message).toContain("expected type comes from")
    expect(diags[1]!.code).toBe(2304)
    expect(diags[1]!.severity).toBe("P0")
  })

  test("caps at maxErrors", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `f${i}.ts(1,1): error TS2304: n${i}.`).join("\n")
    expect(parseDiagnostics(lines, 3)).toHaveLength(3)
  })

  test("clusters by code and message", () => {
    const diags = parseDiagnostics(
      ["a.ts(1,1): error TS2304: Cannot find name 'x'.", "b.ts(2,2): error TS2304: Cannot find name 'x'.", "c.ts(1,1): error TS2322: Bad type."].join("\n"),
      80,
    )
    const clusters = clusterDiagnostics(diags)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]!.severity).toBe("P0")
    expect(clusters[0]!.count).toBe(2)
  })
})

describe("tool.typecheck", () => {
  it.instance("full mode requires a reason", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TypecheckTool.id)
      if (!tool) throw new Error("typecheck tool not found")
      const exit = yield* tool.execute({ mode: "full" }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("file mode typechecks a clean file and reports passed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }))
      yield* write(test.directory, "ok.ts", "export const x: number = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TypecheckTool.id)
      if (!tool) throw new Error("typecheck tool not found")

      const { items, ctx } = asks()
      const result = yield* tool.execute({ mode: "file", filePath: "ok.ts" }, ctx)
      expect(result.output).toContain('status="passed"')
      expect(items.some((i) => i.permission === "typecheck")).toBe(true)
    }),
  )

  it.instance("file mode surfaces a syntax error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }))
      yield* write(test.directory, "bad.ts", "export const = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TypecheckTool.id)
      if (!tool) throw new Error("typecheck tool not found")

      const result = yield* tool.execute({ mode: "file", filePath: "bad.ts" }, asks().ctx)
      expect(result.output).toContain('status="failed"')
      expect(result.output).toContain("<diagnostics>")
    }),
  )

  it.instance("folder mode rejects a missing folder", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TypecheckTool.id)
      if (!tool) throw new Error("typecheck tool not found")
      const exit = yield* tool.execute({ mode: "folder", folder: "missing-dir" }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("explain mode explains a TS code", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TypecheckTool.id)
      if (!tool) throw new Error("typecheck tool not found")
      const result = yield* tool.execute({ mode: "explain", filePath: "TS2307" }, asks().ctx)
      expect(result.output).toContain('code="TS2307"')
      expect(result.output).toContain("Cannot find module")
    }),
  )
})
