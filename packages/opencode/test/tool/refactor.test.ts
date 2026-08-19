import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { RefactorTool } from "../../src/tool/refactor"
import { applyTextEdits, isGeneratedPath } from "../../src/tool/refactor"
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
const readText = (p: string) => Effect.promise(() => Bun.file(p).text())

describe("refactor helpers (pure)", () => {
  test("applyTextEdits applies non-overlapping edits and rejects overlaps", () => {
    const out = applyTextEdits("hello world", [
      { start: 0, end: 5, newText: "Hi" },
      { start: 6, end: 11, newText: "there" },
    ])
    expect(out).toBe("Hi there")
    expect(() =>
      applyTextEdits("abc", [
        { start: 0, end: 2, newText: "x" },
        { start: 1, end: 3, newText: "y" },
      ]),
    ).toThrow(/[Oo]verlapping/)
  })

  test("isGeneratedPath flags generated files", () => {
    expect(isGeneratedPath("src/foo.generated.ts")).toBe(true)
    expect(isGeneratedPath("src/__generated__/x.ts")).toBe(true)
    expect(isGeneratedPath("src/foo.ts")).toBe(false)
  })
})

describe("tool.refactor", () => {
  it.instance("organizeImports dry-run produces a preview and saves no write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.ts", "import { b } from './b'\nimport { a } from './a'\nexport const x = 1\n")
      yield* write(test.directory, "b.ts", "export const b = 1\n")
      yield* write(test.directory, "a1.ts", "export const a = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const result = yield* tool.execute({ mode: "organizeImports", filePath: "a.ts" }, asks().ctx)
      expect(result.metadata.status).toBe("preview")
      expect(result.metadata.previewId).toBeDefined()
      // File untouched in dry-run.
      expect(yield* readText(path.join(test.directory, "a.ts"))).toContain("import { b }")
    }),
  )

  it.instance("apply without confirm is rejected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.ts", "import { b } from './b'\nexport const x = 1\n")
      yield* write(test.directory, "b.ts", "export const b = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const exit = yield* tool
        .execute({ mode: "organizeImports", filePath: "a.ts", dryRun: false }, asks().ctx)
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("updateImportSource rewrites only AST module specifiers (dry-run preview)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // A string literal inside a comment/string must NOT be rewritten.
      yield* write(
        test.directory,
        "a.ts",
        [
          "import x from 'old-module'",
          "// the text 'old-module' appears here but is a comment",
          "const s = 'old-module'",
          "export { x }",
        ].join("\n"),
      )
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const result = yield* tool.execute(
        { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" },
        asks().ctx,
      )
      expect(result.metadata.status).toBe("preview")

      // Apply with confirm and verify AST-only semantics.
      const applied = yield* tool.execute(
        {
          mode: "updateImportSource",
          filePath: "a.ts",
          from: "old-module",
          to: "new-module",
          previewId: result.metadata.previewId,
          dryRun: false,
          confirm: "REFACTOR",
          runTypecheck: false,
        },
        asks().ctx,
      )
      expect(applied.metadata.status).toBe("applied")
      const content = yield* readText(path.join(test.directory, "a.ts"))
      expect(content).toContain("import x from 'new-module'")
      expect(content).toContain("// the text 'old-module' appears here")
      expect(content).toContain("const s = 'old-module'")
    }),
  )

  it.instance("stale preview is rejected after the file changes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.ts", "import x from 'old-module'\nexport const v = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const preview = yield* tool.execute(
        { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" },
        asks().ctx,
      )
      // Touch the file after preview.
      yield* write(test.directory, "a.ts", "import x from 'old-module'\nexport const v = 2\n")

      const exit = yield* tool
        .execute(
          {
            mode: "updateImportSource",
            filePath: "a.ts",
            from: "old-module",
            to: "new-module",
            previewId: preview.metadata.previewId,
            dryRun: false,
            confirm: "REFACTOR",
            runTypecheck: false,
          },
          asks().ctx,
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("renameSymbol dry-run previews cross-file locations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "dep.ts", "export const counter = 1\n")
      yield* write(test.directory, "main.ts", "import { counter } from './dep'\nconsole.log(counter)\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const result = yield* tool.execute(
        { mode: "renameSymbol", filePath: "main.ts", line: 1, column: 10, newName: "count" },
        asks().ctx,
      )
      expect(result.metadata.status).toBe("preview")
      expect(result.metadata.changedFiles).toBeGreaterThan(0)
    }),
  )

  it.instance("noop plan returns status noop without saving", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.ts", "import { b } from './b'\nexport const x = 1\n")
      yield* write(test.directory, "b.ts", "export const b = 1\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, RefactorTool.id)
      if (!tool) throw new Error("refactor tool not found")

      const result = yield* tool.execute({ mode: "organizeImports", filePath: "b.ts" }, asks().ctx)
      expect(result.metadata.status).toBe("noop")
    }),
  )
})
