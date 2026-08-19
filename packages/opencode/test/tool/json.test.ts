import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { JsonTool } from "../../src/tool/json"
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

const SAMPLE = `{
  "name": "acme",
  "version": "1.2.3",
  "users": [
    { "id": 1, "name": "alice", "active": true },
    { "id": 2, "name": "bob", "active": false }
  ],
  "tags": ["a", "b", "a"]
}`

describe("tool.json", () => {
  it.instance("scaffolds a JSON file with paths and pointers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const result = yield* tool.execute({ mode: "scaffold", filePath: "app.json" }, asks().ctx)
      expect(result.output).toContain("<json-scaffold")
      expect(result.output).toContain("users")
      expect(result.output).toContain("path=$.users[0].name")
      expect(result.output).toContain("ptr=/users/0/name")
      expect(result.output).toContain("objects=3")
    }),
  )

  it.instance("reports validation errors with line/column", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "bad.json", '{\n  "a": 1,\n  "b": [1, 2\n}')
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const result = yield* tool.execute({ mode: "validate", filePath: "bad.json" }, asks().ctx)
      expect(result.output).toContain('ok="false"')
      expect(result.output).toContain("line=")
      expect(result.output).toContain("column=")
    }),
  )

  it.instance("queries a JSONPath", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const result = yield* tool.execute({ mode: "query", filePath: "app.json", path: "$.users[0].name" }, asks().ctx)
      expect(result.output).toContain('found="true"')
      expect(result.output).toContain("alice")

      const missing = yield* tool.execute({ mode: "query", filePath: "app.json", path: "$.users[5]" }, asks().ctx)
      expect(missing.output).toContain('found="false"')
    }),
  )

  it.instance("searches keys and values", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const byValue = yield* tool.execute({ mode: "search", filePath: "app.json", query: "alice" }, asks().ctx)
      expect(byValue.output).toContain("alice")

      const byKey = yield* tool.execute({ mode: "search", filePath: "app.json", query: "active" }, asks().ctx)
      expect(byKey.output).toContain("reason=\"key\"")
    }),
  )

  it.instance("infers a schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const result = yield* tool.execute({ mode: "schema", filePath: "app.json" }, asks().ctx)
      expect(result.output).toContain("<json-schema")
      expect(result.output).toContain("&quot;type&quot;: &quot;object&quot;")
      expect(result.output).toContain("users")
    }),
  )

  it.instance("formats dry-run by default, then writes on dryRun:false", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const dry = yield* tool.execute({ mode: "format", filePath: "app.json", indent: 0 }, asks().ctx)
      expect(dry.output).toContain('written="false"')
      expect(dry.output).toContain("dry run")
      // file unchanged
      expect(yield* readText(path.join(test.directory, "app.json"))).toBe(SAMPLE)

      const { items, ctx } = asks()
      const applied = yield* tool.execute({ mode: "format", filePath: "app.json", indent: 0, dryRun: false }, ctx)
      expect(applied.output).toContain('written="true"')
      expect(items.map((i) => i.permission)).toContain("edit")
      const minified = yield* readText(path.join(test.directory, "app.json"))
      expect(minified).not.toContain("\n")
      expect(JSON.parse(minified)).toEqual(JSON.parse(SAMPLE))
    }),
  )

  it.instance("patches dry-run by default, then applies on dryRun:false", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "app.json", SAMPLE)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const ops = [
        { op: "replace", path: "/version", value: "2.0.0" },
        { op: "add", path: "/users/-", value: { id: 3, name: "carol", active: true } },
      ]
      const dry = yield* tool.execute({ mode: "patch", filePath: "app.json", patch: ops }, asks().ctx)
      expect(dry.output).toContain('written="false"')
      expect(yield* readText(path.join(test.directory, "app.json"))).toBe(SAMPLE)

      const applied = yield* tool.execute({ mode: "patch", filePath: "app.json", patch: ops, dryRun: false }, asks().ctx)
      expect(applied.output).toContain('written="true"')
      expect(applied.output).toContain('kind="replace"')
      const next = JSON.parse(yield* readText(path.join(test.directory, "app.json")))
      expect(next.version).toBe("2.0.0")
      expect(next.users).toHaveLength(3)
      expect(next.users[2].name).toBe("carol")
    }),
  )

  it.instance("diffs two files structurally", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.json", '{"x": 1, "keep": true}')
      yield* write(test.directory, "b.json", '{"x": 2, "keep": true, "new": 5}')
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const result = yield* tool.execute(
        { mode: "diff", filePath: "a.json", compareFilePath: "b.json" },
        asks().ctx,
      )
      expect(result.output).toContain('<json-diff changes="2"')
      expect(result.output).toContain('kind="changed"')
      expect(result.output).toContain('kind="added"')
    }),
  )

  it.instance("works on jsonText input without touching the filesystem", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const { items, ctx } = asks()
      const result = yield* tool.execute({ mode: "query", jsonText: '{"a": {"b": [10, 20]}}', path: "$.a.b[1]" }, ctx)
      expect(result.output).toContain("20")
      expect(items.length).toBe(0)
      expect(test.directory).toBeTruthy()
    }),
  )

  it.instance("rejects an unsupported JSONPath", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, JsonTool.id)
      if (!tool) throw new Error("json tool not found")

      const exit = yield* tool
        .execute({ mode: "query", jsonText: '{"a":1}', path: "users.0" }, asks().ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
