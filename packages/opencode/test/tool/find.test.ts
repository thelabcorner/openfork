import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FindTool } from "../../src/tool/find"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import { Plugin } from "@/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((_name: unknown, _input: unknown, output: unknown) => Effect.succeed(output)) as Plugin.Interface["trigger"],
  }),
)

const toolLayer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node])),
  pluginLayer,
)
const it = testEffect(toolLayer)

const ctx = {
  sessionID: SessionID.make("ses_find_test"),
  messageID: MessageID.make("msg_find_test"),
  callID: "call_find_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

describe("tool.find", () => {
  it.instance("routes glob searches through the file-discovery path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* FindTool
      const find = yield* info.init()
      const result = yield* find.execute({ glob: "*.ts", path: test.directory }, ctx)

      expect(result.metadata.action).toBe("glob")
      expect(result.metadata.delegatedTool).toBe("glob")
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("routes grep searches and supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "target.ts")
      const sibling = path.join(test.directory, "sibling.ts")
      yield* Effect.promise(() => Bun.write(file, "alpha\nneedle\nomega\n"))
      yield* Effect.promise(() => Bun.write(sibling, "needle sibling\n"))
      const info = yield* FindTool
      const find = yield* info.init()
      const result = yield* find.execute({ grep: "needle", path: file }, ctx)

      expect(result.metadata.action).toBe("grep")
      expect(result.metadata.delegatedTool).toBe("grep")
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).not.toContain(sibling)
    }),
  )

  it.instance("rejects ambiguous or invalid operation combinations", () =>
    Effect.gen(function* () {
      const info = yield* FindTool
      const find = yield* info.init()

      const neither = yield* find.execute({}, ctx).pipe(Effect.exit)
      const both = yield* find.execute({ glob: "*.ts", grep: "needle" }, ctx).pipe(Effect.exit)
      const includeWithGlob = yield* find.execute({ glob: "*.ts", include: "*.ts" }, ctx).pipe(Effect.exit)

      expect(neither._tag).toBe("Failure")
      expect(both._tag).toBe("Failure")
      expect(includeWithGlob._tag).toBe("Failure")
    }),
  )

  it.instance("preserves legacy glob and grep permission keys", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "needle\n"))
      const permissions: string[] = []
      const next: Tool.Context = {
        ...ctx,
        ask: (request) =>
          Effect.sync(() => {
            permissions.push(request.permission)
          }),
      }
      const info = yield* FindTool
      const find = yield* info.init()

      yield* find.execute({ glob: "*.ts", path: test.directory }, next)
      yield* find.execute({ grep: "needle", path: test.directory, include: "*.ts" }, next)

      expect(permissions).toEqual(["glob", "grep"])
    }),
  )
})
