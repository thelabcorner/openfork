import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { GitTool } from "../../src/tool/git"
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

const git = (dir: string, args: string[]) =>
  Effect.promise(() => Bun.$`git ${args}`.cwd(dir).quiet().nothrow().text())

describe("tool.git", () => {
  it.instance("reports not-in-a-repo cleanly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")
      const exit = yield* tool.execute({ mode: "status" }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("status shows clean tree in a fresh repo", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "content")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "init"])
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const result = yield* tool.execute({ mode: "status" }, asks().ctx)
      expect(result.output).toContain("working tree clean")
    }),
  )

  it.instance("status lists modified files with paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "v1")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "init"])
      yield* write(test.directory, "a.txt", "v2")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const result = yield* tool.execute({ mode: "status" }, asks().ctx)
      expect(result.output).toContain("a.txt")
    }),
  )

  it.instance("stage-all requires STAGE_ALL confirm", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "v1")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const exit = yield* tool.execute({ mode: "stage" }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      const result = yield* tool.execute({ mode: "stage", confirm: "STAGE_ALL" }, asks().ctx)
      expect(result.output).toContain("<staged")
    }),
  )

  it.instance("stage with explicit paths works without confirm", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "v1")
      yield* write(test.directory, "b.txt", "v2")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const result = yield* tool.execute({ mode: "stage", paths: ["a.txt"] }, asks().ctx)
      expect(result.output).toContain("<staged")
      const staged = yield* git(test.directory, ["diff", "--cached", "--name-only"])
      expect(staged).toContain("a.txt")
      expect(staged).not.toContain("b.txt")
    }),
  )

  it.instance("rejects absolute and escaping paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const abs = yield* tool.execute({ mode: "stage", paths: [path.join(test.directory, "a.txt")] }, asks().ctx).pipe(Effect.exit)
      expect(abs._tag).toBe("Failure")
      const escape = yield* tool.execute({ mode: "stage", paths: ["../outside.txt"] }, asks().ctx).pipe(Effect.exit)
      expect(escape._tag).toBe("Failure")
    }),
  )

  it.instance("commit is dry-run by default and requires COMMIT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "v1")
      yield* git(test.directory, ["add", "a.txt"])
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const dry = yield* tool.execute({ mode: "commit", message: "hello" }, asks().ctx)
      expect(dry.output).toContain("dry-run")

      const noConfirm = yield* tool.execute({ mode: "commit", message: "hello", dryRun: false }, asks().ctx).pipe(Effect.exit)
      expect(noConfirm._tag).toBe("Failure")

      const applied = yield* tool.execute({ mode: "commit", message: "hello", dryRun: false, confirm: "COMMIT" }, asks().ctx)
      expect(applied.output).toContain('<commit applied="true"')
      const log = yield* git(test.directory, ["log", "--oneline"])
      expect(log).toContain("hello")
    }),
  )

  it.instance("shell mode refuses write subcommands", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const exit = yield* tool.execute({ mode: "shell", argv: ["reset", "--hard"] }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      const ok = yield* tool.execute({ mode: "shell", argv: ["rev-parse", "--is-inside-work-tree"] }, asks().ctx)
      expect(ok.output).toContain("true")
    }),
  )

  it.instance("shell mode blocks -C and --git-dir", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const exit = yield* tool.execute({ mode: "shell", argv: ["status", "-C", "/somewhere"] }, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("restore refuses when unmerged conflicts exist", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* git(test.directory, ["config", "user.email", "test@test"])
      yield* git(test.directory, ["config", "user.name", "Test"])
      yield* write(test.directory, "a.txt", "base")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "base"])
      // Create a genuine unmerged index state via a conflicting merge.
      yield* git(test.directory, ["checkout", "-q", "-b", "side"])
      yield* write(test.directory, "a.txt", "side change")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "side"])
      yield* git(test.directory, ["checkout", "-q", "master"])
      yield* write(test.directory, "a.txt", "master change")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "master"])
      yield* git(test.directory, ["merge", "side"]).pipe(Effect.catch(() => Effect.void))
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const exit = yield* tool
        .execute({ mode: "restore", paths: ["a.txt"], confirm: "RESTORE_WORKTREE" }, asks().ctx)
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("restore worktree discards changes with confirm", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "original")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "init"])
      yield* write(test.directory, "a.txt", "modified")

      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const result = yield* tool.execute({ mode: "restore", paths: ["a.txt"], confirm: "RESTORE_WORKTREE" }, asks().ctx)
      expect(result.output).toContain("<restored")
      expect(yield* readText(path.join(test.directory, "a.txt"))).toBe("original")
    }),
  )

  it.instance("log and diff are read-only", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* git(test.directory, ["init", "-q"])
      yield* write(test.directory, "a.txt", "v1")
      yield* git(test.directory, ["add", "a.txt"])
      yield* git(test.directory, ["commit", "-q", "-m", "first"])
      yield* write(test.directory, "a.txt", "v2")

      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, GitTool.id)
      if (!tool) throw new Error("git tool not found")

      const log = yield* tool.execute({ mode: "log", maxCount: 5 }, asks().ctx)
      expect(log.output).toContain("first")

      const diff = yield* tool.execute({ mode: "diff", paths: ["a.txt"] }, asks().ctx)
      expect(diff.output).toContain("v2")
    }),
  )
})
