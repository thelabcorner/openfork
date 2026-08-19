import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { PatchTool } from "../../src/tool/patch"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff: string
    filepath: string
    files: Array<Record<string, unknown>>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
}

type PatchParams = {
  patchText: string
  apply?: boolean
  format?: "auto" | "opencode" | "git"
  showDiff?: boolean
}

const execute = Effect.fn("PatchToolTest.execute")(function* (params: PatchParams, ctx: ToolCtx) {
  const info = yield* PatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
  }
  return { ctx, calls }
}

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

const expectReadFailure = (filepath: string) => expectFailure(readText(filepath))

const OPENCODE_PATCH = [
  "*** Begin Patch",
  "*** Add File: nested/new.txt",
  "+created",
  "*** Update File: modify.txt",
  "@@",
  "-line2",
  "+changed",
  "*** Delete File: delete.txt",
  "*** End Patch",
].join("\n")

const GIT_PATCH = [
  "diff --git a/modify.txt b/modify.txt",
  "index 111..222 100644",
  "--- a/modify.txt",
  "+++ b/modify.txt",
  "@@ -1,2 +1,2 @@",
  " line1",
  "-line2",
  "+changed",
  "",
  "diff --git a/nested/new.txt b/nested/new.txt",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/nested/new.txt",
  "@@ -0,0 +1,1 @@",
  "+created",
].join("\n")

describe("tool.patch", () => {
  it.live("requires patchText", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "" }, ctx), "patchText is required")
    }),
  )

  it.live("rejects empty patch", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** End Patch" }, ctx),
        "patch rejected: empty patch",
      )
    }),
  )

  it.live("gives an instructive parse error for garbage input", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "this is not a patch" }, ctx), "Invalid patch")
      yield* expectFailure(execute({ patchText: "this is not a patch" }, ctx), "opencode format example")
    }),
  )

  it.instance("dry-run opencode returns a plan and writes nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")
      yield* writeText(path.join(test.directory, "delete.txt"), "obsolete\n")

      const result = yield* execute({ patchText: OPENCODE_PATCH }, ctx)

      expect(result.output).toContain("dry-run plan")
      expect(result.output).toContain("format: opencode")
      expect(result.output).toContain("A nested/new.txt (+1/-0) clean")
      expect(result.output).toContain("M modify.txt (+1/-1) clean")
      expect(result.output).toContain("D delete.txt (+0/-1) clean")
      expect(result.metadata.applied).toBe(false)
      // No permission ask, nothing written
      expect(calls.length).toBe(0)
      yield* expectReadFailure(path.join(test.directory, "nested", "new.txt"))
      expect(yield* readText(path.join(test.directory, "modify.txt"))).toBe("line1\nline2\n")
    }),
    { git: true },
  )

  it.instance("showDiff toggles the diff echo in the plan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")
      const patch = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

      // Default dry-run: token-lean plan, no diff content leaks into the output.
      const lean = yield* execute({ patchText: patch }, ctx)
      expect(lean.output).toContain("M modify.txt (+1/-1) clean")
      expect(lean.output).not.toContain("--- diff")
      expect(lean.output).not.toContain("-line2")

      // showDiff:true appends the per-file diff.
      const verbose = yield* execute({ patchText: patch, showDiff: true }, ctx)
      expect(verbose.output).toContain("--- diff modify.txt")
      expect(verbose.output).toContain("-line2")
      expect(verbose.output).toContain("+changed")
      expect(verbose.output).toContain("--- end diff")
    }),
    { git: true },
  )

  it.instance("dry-run git returns a plan and writes nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")

      const result = yield* execute({ patchText: GIT_PATCH }, ctx)

      expect(result.output).toContain("dry-run plan")
      expect(result.output).toContain("format: git")
      expect(result.output).toContain("A nested/new.txt (+1/-0) clean")
      expect(result.output).toContain("M modify.txt (+1/-1) clean")
      expect(calls.length).toBe(0)
      yield* expectReadFailure(path.join(test.directory, "nested", "new.txt"))
    }),
    { git: true },
  )

  it.instance("apply opencode writes all files with one edit ask", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const modifyPath = path.join(test.directory, "modify.txt")
      const deletePath = path.join(test.directory, "delete.txt")
      yield* writeText(modifyPath, "line1\nline2\n")
      yield* writeText(deletePath, "obsolete\n")

      const result = yield* execute({ patchText: OPENCODE_PATCH, apply: true }, ctx)

      expect(result.output).toContain("applied 3 changes")
      expect(result.output).toContain("A nested/new.txt (+1/-0)")
      expect(result.output).toContain("M modify.txt (+1/-1)")
      expect(result.output).toContain("D delete.txt (+0/-1)")
      expect(calls.length).toBe(1)
      const ask = calls[0]
      expect(ask.permission).toBe("edit")
      expect(ask.metadata.files).toHaveLength(3)
      expect(ask.metadata.diff).toContain("+created")

      expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
      expect(yield* readText(modifyPath)).toBe("line1\nchanged\n")
      yield* expectReadFailure(deletePath)
    }),
    { git: true },
  )

  it.instance("apply git writes all files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")

      const result = yield* execute({ patchText: GIT_PATCH, apply: true }, ctx)

      expect(result.output).toContain("applied 2 changes")
      expect(result.output).toContain("format: git")
      expect(calls.length).toBe(1)
      expect(yield* readText(path.join(test.directory, "modify.txt"))).toBe("line1\nchanged\n")
      expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
    }),
    { git: true },
  )

  it.instance("git rename translates to a move (R)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* Effect.promise(() => fs.mkdir(path.dirname(original), { recursive: true }))
      yield* writeText(original, "old content\n")

      const patch =
        "--- a/old/name.txt\n+++ b/renamed/name.txt\n@@ -1,1 +1,1 @@\n-old content\n+new content\n"

      const plan = yield* execute({ patchText: patch }, ctx)
      expect(plan.output).toContain("R old/name.txt -> renamed/name.txt")
      expect(plan.output).toContain("clean")

      yield* execute({ patchText: patch, apply: true }, ctx)
      yield* expectReadFailure(original)
      expect(yield* readText(path.join(test.directory, "renamed", "name.txt"))).toBe("new content\n")
    }),
    { git: true },
  )

  it.instance("reports conflicts per-file in the dry-run plan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")
      const patch =
        "*** Begin Patch\n*** Add File: ok.txt\n+fine\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      const result = yield* execute({ patchText: patch }, ctx)

      expect(result.output).toContain("1 conflict")
      expect(result.output).toContain("A ok.txt (+1/-0) clean")
      expect(result.output).toContain("CONFLICT")
      expect(result.output).toContain("modify.txt")
      expect(calls.length).toBe(0)
      yield* expectReadFailure(path.join(test.directory, "ok.txt"))
    }),
    { git: true },
  )

  it.instance("apply is atomic: any conflict means nothing is written", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")
      const patch =
        "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "patch verification failed")
      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "modify.txt")
      expect(calls.length).toBe(0)
      yield* expectReadFailure(path.join(test.directory, "created.txt"))
      expect(yield* readText(path.join(test.directory, "modify.txt"))).toBe("line1\nline2\n")
    }),
    { git: true },
  )

  it.instance("missing update target is a conflict, not a crash", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patch = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

      const result = yield* execute({ patchText: patch }, ctx)
      expect(result.output).toContain("CONFLICT")
      expect(result.output).toContain("missing.txt")

      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "file not found")
    }),
  )

  it.instance("no-op patch reports no changes and never writes or asks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const target = path.join(test.directory, "same.txt")
      yield* writeText(target, "line1\nline2\n")
      const patch = "*** Begin Patch\n*** Update File: same.txt\n@@\n-line2\n+line2\n*** End Patch"

      const plan = yield* execute({ patchText: patch }, ctx)
      expect(plan.output).toContain("no changes")
      expect(calls.length).toBe(0)

      const applied = yield* execute({ patchText: patch, apply: true }, ctx)
      expect(applied.output).toContain("no changes to apply")
      expect(calls.length).toBe(0)
      expect(yield* readText(target)).toBe("line1\nline2\n")
    }),
    { git: true },
  )

  it.instance("respects an explicit format hint and reports it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "x.txt"), "a\n")
      const gitPatch = "--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"

      const plan = yield* execute({ patchText: gitPatch, format: "git" }, ctx)
      expect(plan.output).toContain("format: git")

      // Forcing opencode on a git diff must fail instructively
      yield* expectFailure(execute({ patchText: gitPatch, format: "opencode" }, ctx), "Invalid patch")
    }),
    { git: true },
  )

  it.instance("tool id is patch (registers under its own id, ungated)", () =>
    Effect.gen(function* () {
      const info = yield* PatchTool
      expect(info.id).toBe("patch")
    }),
  )
})
