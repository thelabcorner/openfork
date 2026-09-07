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
    mode: string
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

      const result = yield* execute({ patchText: OPENCODE_PATCH, apply: false }, ctx)

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
      const lean = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(lean.output).toContain("M modify.txt (+1/-1) clean")
      expect(lean.output).not.toContain("--- diff")
      expect(lean.output).not.toContain("-line2")

      // showDiff:true appends the per-file diff.
      const verbose = yield* execute({ patchText: patch, showDiff: true, apply: false }, ctx)
      expect(verbose.output).toContain("--- diff modify.txt")
      expect(verbose.output).toContain("-line2")
      expect(verbose.output).toContain("+changed")
      expect(verbose.output).toContain("--- end diff")
    }),
    { git: true },
  )
  it.instance("merges repeated Update File sections for one path instead of dropping the first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "same.txt"), "one\ntwo\nthree\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: same.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: same.txt",
        "@@",
        "-three",
        "+THREE",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("M same.txt (+2/-2) clean")
      yield* execute({ patchText: patch, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "same.txt"))).toBe("ONE\ntwo\nTHREE\n")
    }),
    { git: true },
  )
  it.instance("applies update sections onto added files in the same patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patch = [
        "*** Begin Patch",
        "*** Add File: fresh.txt",
        "+hello",
        "*** Update File: fresh.txt",
        "@@",
        "-hello",
        "+hello world",
        "*** End Patch",
      ].join("\n")
      yield* execute({ patchText: patch, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "fresh.txt"))).toBe("hello world\n")
    }),
    { git: true },
  )
  it.instance("reports delete-plus-update collisions as conflicts instead of losing writes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "gone.txt"), "bye\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: gone.txt",
        "@@",
        "-bye",
        "+hi",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch }, ctx)
      expect(plan.output).toContain("CONFLICT")
      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "verification failed")
      expect(yield* readText(path.join(test.directory, "gone.txt"))).toBe("bye\n")
    }),
    { git: true },
  )
  it.instance("merges out-of-order sections by resolved position", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "ooo.txt"), "one\ntwo\nthree\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: ooo.txt",
        "@@",
        "-three",
        "+THREE",
        "*** Update File: ooo.txt",
        "@@",
        "-one",
        "+ONE",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("M ooo.txt (+2/-2) clean")
      yield* execute({ patchText: patch, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "ooo.txt"))).toBe("ONE\ntwo\nTHREE\n")
    }),
    { git: true },
  )
  it.instance("rejects overlapping chunks across merged sections", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "ov.txt"), "one\ntwo\nthree\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: ov.txt",
        "@@",
        "-two",
        "+TWO",
        "*** Update File: ov.txt",
        "@@",
        "-two",
        "+2",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("CONFLICT")
      expect(plan.output).toContain("overlapping chunks")
      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "verification failed")
      expect(calls.length).toBe(0)
      expect(yield* readText(path.join(test.directory, "ov.txt"))).toBe("one\ntwo\nthree\n")
    }),
    { git: true },
  )

  it.instance("dry-run git returns a plan and writes nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "modify.txt"), "line1\nline2\n")

      const result = yield* execute({ patchText: GIT_PATCH, apply: false }, ctx)

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
      expect(ask.metadata.mode).toBe("apply")
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

      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
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
  it.instance("if-clean applies without a separate dry-run when nothing conflicts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "same.txt"), "one\ntwo\n")
      const patch = "*** Begin Patch\n*** Update File: same.txt\n@@\n-one\n+ONE\n*** End Patch"
      const result = yield* execute({ patchText: patch }, ctx)
      expect(result.output).toContain("applied 1 change")
      expect(result.output).toContain("mode: if-clean")
      expect(calls.length).toBe(1)
      expect(calls[0].metadata.mode).toBe("if-clean-apply")
      expect(yield* readText(path.join(test.directory, "same.txt"))).toBe("ONE\ntwo\n")
    }),
    { git: true },
  )
  it.instance("if-clean returns the plan without asking when conflicts exist", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "same.txt"), "one\ntwo\n")
      const patch = "*** Begin Patch\n*** Update File: same.txt\n@@\n-missing\n+changed\n*** End Patch"
      const result = yield* execute({ patchText: patch }, ctx)
      expect(result.output).toContain("mode: if-clean")
      expect(result.output).toContain("CONFLICT")
      expect(calls.length).toBe(0)
      expect(yield* readText(path.join(test.directory, "same.txt"))).toBe("one\ntwo\n")
    }),
    { git: true },
  )
  it.instance("D49: duplicate-candidate hunk is refused with candidate lines", () =>
    Effect.gen(function* () {
      // Three identical blocks; the hunk equals all three. A cursor-only
      // design lands it on the first silently; the shared uniqueness rule
      // refuses with every candidate line number instead.
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      yield* writeText(path.join(test.directory, "dup.txt"), "header\nbody\nfooter\nheader\nbody\nfooter\nheader\nbody\nfooter\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: dup.txt",
        "@@",
        "-header",
        "-body",
        "-footer",
        "+HEADER",
        "+body",
        "+footer",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("CONFLICT")
      expect(plan.output).toContain("1, 4, 7")
      yield* expectFailure(execute({ patchText: patch, apply: true }, ctx), "verification failed")
      expect(calls.length).toBe(0)
      expect(yield* readText(path.join(test.directory, "dup.txt"))).toBe(
        "header\nbody\nfooter\nheader\nbody\nfooter\nheader\nbody\nfooter\n",
      )
    }),
    { git: true },
  )
  it.instance("two-pass disambiguation resolves a duplicate candidate between anchored hunks", () =>
    Effect.gen(function* () {
      // Blocks 1 and 3 are uniquely anchored; the middle hunk is ambiguous
      // file-wide but unique inside the window they bound.
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "tri.txt"), "one\nh\nb\nf\ntwo\nh\nb\nf\nthree\nh\nb\nf\n")
      const forward = [
        "*** Begin Patch",
        "*** Update File: tri.txt",
        "@@",
        "-one",
        "-h",
        "-b",
        "-f",
        "+ONE",
        "+h",
        "+b",
        "+f",
        "@@",
        "-h",
        "-b",
        "-f",
        "+H",
        "+B",
        "+F",
        "@@",
        "-three",
        "-h",
        "-b",
        "-f",
        "+THREE",
        "+h",
        "+b",
        "+f",
        "*** End Patch",
      ].join("\n")
      const expected = "ONE\nh\nb\nf\ntwo\nH\nB\nF\nTHREE\nh\nb\nf\n"
      const plan = yield* execute({ patchText: forward, apply: false }, ctx)
      expect(plan.output).toContain("M tri.txt (+5/-5) clean")
      yield* execute({ patchText: forward, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "tri.txt"))).toBe(expected)
    }),
    { git: true },
  )
  it.instance("reversed authoring resolves identically (D3 composition)", () =>
    Effect.gen(function* () {
      // Same three hunks, authored last-to-first. Gap probing (not patch-order
      // neighbours) makes resolution order-independent.
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "tri.txt"), "one\nh\nb\nf\ntwo\nh\nb\nf\nthree\nh\nb\nf\n")
      const reversed = [
        "*** Begin Patch",
        "*** Update File: tri.txt",
        "@@",
        "-three",
        "-h",
        "-b",
        "-f",
        "+THREE",
        "+h",
        "+b",
        "+f",
        "@@",
        "-h",
        "-b",
        "-f",
        "+H",
        "+B",
        "+F",
        "@@",
        "-one",
        "-h",
        "-b",
        "-f",
        "+ONE",
        "+h",
        "+b",
        "+f",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: reversed, apply: false }, ctx)
      expect(plan.output).toContain("M tri.txt (+5/-5) clean")
      yield* execute({ patchText: reversed, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "tri.txt"))).toBe("ONE\nh\nb\nf\ntwo\nH\nB\nF\nTHREE\nh\nb\nf\n")
    }),
    { git: true },
  )
  it.instance("orders out-of-order chunks within a single section", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "rev.txt"), "one\ntwo\nthree\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: rev.txt",
        "@@",
        "-three",
        "+THREE",
        "@@",
        "-one",
        "+ONE",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("M rev.txt (+2/-2) clean")
      yield* execute({ patchText: patch, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "rev.txt"))).toBe("ONE\ntwo\nTHREE\n")
    }),
    { git: true },
  )
  it.instance("resolves chunks by full pattern, not first line", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "dbl.txt"), "a\nb1\nc\na\nb2\nc\n")
      const patch = [
        "*** Begin Patch",
        "*** Update File: dbl.txt",
        "@@",
        "-a",
        "-b1",
        "-c",
        "+a",
        "+B1",
        "+c",
        "@@",
        "-a",
        "-b2",
        "-c",
        "+a",
        "+B2",
        "+c",
        "*** End Patch",
      ].join("\n")
      const plan = yield* execute({ patchText: patch, apply: false }, ctx)
      expect(plan.output).toContain("M dbl.txt (+2/-2) clean")
      yield* execute({ patchText: patch, apply: true }, ctx)
      expect(yield* readText(path.join(test.directory, "dbl.txt"))).toBe("a\nB1\nc\na\nB2\nc\n")
    }),
    { git: true },
  )
})
