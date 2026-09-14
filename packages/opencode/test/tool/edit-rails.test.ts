import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Option } from "effect"
import { EditTool } from "../../src/tool/edit"
import {
  applyBatch,
  appendToFile,
  applyEditStrategy,
  deleteLines,
  insertAt,
  replaceLine,
  replaceLines,
  replaceNear,
  type StrategyResult,
} from "../../src/tool/edit/strategy"
import { applySpans } from "../../src/tool/edit/span"
import { adaptReplacementTerminators } from "@opencode-ai/core/line-ending"
import { assertSpansExplain } from "../../src/tool/edit/invariant"
import { resolveMatch, resolveReplacement } from "../../src/tool/edit/match"
import { absorbDeletionNewline, healInput, stripCodeFence, stripReadPrefix } from "../../src/tool/edit/heal"
import { enforce as enforcePriorRead, globalReadCache, ReadCache } from "../../src/tool/edit/prior-read"
import { withRollback } from "../../src/tool/patch/rollback"
import { applyTextEdits } from "../../src/tool/refactor"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("EditRailTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditRailTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditRailTest.fail")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditRailTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditRailTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

// The invariant harness runs inside every strategy test, not as its own
// suite: bytes outside the reported spans must be byte-identical to the
// input, and the spans must fully explain the output.
const check = (before: string, result: StrategyResult): string => {
  const after = applySpans(before, result.spans)
  assertSpansExplain(before, after, result.spans)
  return after
}

// ---- pure strategy unit tests (no runtime needed) ---------------------------

describe("edit strategy helpers (pure)", () => {
  test("replaceLine replaces the target line and echoes oldPreview", () => {
    const result = replaceLine("a\nb\nc", 2, "B", "b")
    expect(check("a\nb\nc", result)).toBe("a\nB\nc")
    expect(result.applied).toBe(1)
    expect(result.oldPreview).toBe("b")
  })

  test("replaceLine requires oldText and verifies it", () => {
    expect(() => replaceLine("a\nb\nc", 2, "B")).toThrow(/requires oldText/)
    expect(() => replaceLine("alpha\nbeta", 1, "x", "omega")).toThrow(/does not contain the expected text/)
    expect(() => replaceLine("alpha", 2, "x", "y")).toThrow(/out of range/)
  })

  test("replaceLine is a no-op when the line already matches", () => {
    const result = replaceLine("a\nb\nc", 2, "b", "b")
    expect(result.applied).toBe(0)
    expect(result.spans).toHaveLength(0)
  })

  test("replaceLines rejects a >5-line range without oldText (R5)", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    expect(() => replaceLines(content, 1, 10, "replacement")).toThrow(/requires oldText/)
  })

  test("replaceLines accepts a >5-line range with endpoint-spanning oldText", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    // Middles are not compared — only the endpoints must match (D14).
    const endpoints = ["line1", "CHANGED", "line10"].join("\n")
    const result = replaceLines(content, 1, 10, "replacement", endpoints)
    expect(check(content, result)).toBe("replacement")
    expect(result.applied).toBe(1)
  })

  test("replaceLines rejects a wide range whose oldText skips the endpoints (D14)", () => {
    const content = "a\nb\nc\nd\ne\nf"
    expect(() => replaceLines(content, 1, 6, "x", "c")).toThrow(/verification failed/)
  })

  test("deleteLines removes the range and consumes its terminators (D11)", () => {
    const before = "a\nb\nc\nd\n"
    const result = deleteLines(before, 2, 3, "b")
    expect(check(before, result)).toBe("a\nd\n")
  })

  test("deleteLines through a final unterminated line leaves no trailing blank", () => {
    const before = "a\nb"
    const result = deleteLines(before, 2, 2, "b")
    expect(check(before, result)).toBe("a")
  })

  test("deleteLines requires oldText", () => {
    expect(() => deleteLines("a\nb", 1, 1)).toThrow(/requires oldText/)
  })

  test("insertAt bounds-checks and inserts after the anchor", () => {
    expect(() => insertAt("a\nb", 5, "x", "b")).toThrow(/out of range/)
    const result = insertAt("a\nb\nc", 1, "inserted", "a")
    expect(check("a\nb\nc", result)).toBe("a\ninserted\nb\nc")
  })

  test("insertAt requires oldText for non-boundary insertions (D13)", () => {
    expect(() => insertAt("a\nb", 1, "x")).toThrow(/requires oldText/)
  })

  test("insertAt:0 prepends without an anchor (D12)", () => {
    const result = insertAt("a\nb", 0, "first")
    expect(check("a\nb", result)).toBe("first\na\nb")
  })

  test("appendToFile appends at EOF (R7 — never prepends)", () => {
    expect(check("first", appendToFile("first", "second"))).toBe("first\nsecond")
    expect(check("first\n", appendToFile("first\n", "second"))).toBe("first\nsecond")
    expect(appendToFile("first", "").applied).toBe(0)
  })

  test("replaceNear rejects a missing anchor (R6)", () => {
    expect(() => replaceNear("a\nb\nc", "zzz", "b", "x")).toThrow(/anchor not found/)
  })

  test("replaceNear rejects an ambiguous oldText within the window (R3)", () => {
    const content = ["anchor", "old", "middle", "old", "tail"].join("\n")
    expect(() => replaceNear(content, "anchor", "old", "x")).toThrow(/multiple lines/)
  })

  test("replaceNear replaces a unique oldText near the anchor", () => {
    const content = ["anchor", "keep me", "old value here", "tail"].join("\n")
    const result = replaceNear(content, "anchor", "old value", "new value")
    expect(check(content, result)).toContain("new value here")
    expect(result.applied).toBe(1)
  })

  test("replaceNear selects a repeated anchor by occurrence", () => {
    const content = ["mark", "v1", "mark", "v2"].join("\n")
    const result = replaceNear(content, "mark", "v2", "V2", 2)
    expect(check(content, result)).toBe(["mark", "v1", "mark", "V2"].join("\n"))
  })

  test("replaceNear refuses an oldText that repeats on the target line", () => {
    const content = ["anchor", "x x", "tail"].join("\n")
    expect(() => replaceNear(content, "anchor", "x", "y")).toThrow(/more than once on line/)
  })

  test("replaceNear rejects when oldText is absent from the window", () => {
    const content = ["anchor", "far away content", "tail"].join("\n")
    expect(() => replaceNear(content, "anchor", "missing", "x")).toThrow(/not found within/)
  })

  test("applyBatch applies line and exact ops against original coordinates (D4)", () => {
    // The exact op changes the line count; line targets still resolve against
    // the original content, so no drift.
    const edits = [
      { line: 2, newText: "line2-new", oldText: "line2" },
      { oldString: "line3", newString: "a\nb\nc" },
    ]
    const result = applyBatch("line1\nline2\nline3", edits)
    expect(check("line1\nline2\nline3", result)).toBe("line1\nline2-new\na\nb\nc")
  })

  test("applyBatch rejects the whole batch when one op fails (R9)", () => {
    const edits = [
      { line: 2, newText: "ok", oldText: "line2" },
      { oldString: "not present anywhere", newString: "x" },
    ]
    expect(() => applyBatch("line1\nline2\nline3", edits)).toThrow()
  })

  test("applyBatch rejects overlapping ops (D5)", () => {
    expect(() =>
      applyBatch("a\nb", [
        { line: 1, newText: "x", oldText: "a" },
        { line: 1, newText: "y", oldText: "a" },
      ]),
    ).toThrow(/overlapping edits/)
  })

  test("applyBatch rejects key mixing (D28)", () => {
    expect(() => applyBatch("a", [{ oldString: "a", newString: "b", line: 1 } as never])).toThrow(/cannot combine/)
  })

  test("applyTextEdits rejects overlapping spans", () => {
    expect(() =>
      applyTextEdits("hello world", [
        { start: 0, end: 5, newText: "a" },
        { start: 3, end: 8, newText: "b" },
      ]),
    ).toThrow(/[Oo]verlapping/)
  })

  test("applyEditStrategy rejects multiple strategy groups (ambiguity guard)", () => {
    expect(() => applyEditStrategy("a\nb", { line: 1, insertAt: 1, newText: "x", oldText: "a" })).toThrow(/multiple strategies/)
  })

  test("applyEditStrategy rejects when no strategy is present", () => {
    expect(() => applyEditStrategy("a\nb", {})).toThrow(/No edit strategy detected/)
  })

  test("applyEditStrategy keeps insertAfter as a deprecated alias", () => {
    const result = applyEditStrategy("a\nb", { insertAfter: 1, newText: "x", oldText: "a" })
    expect(result.strategy).toBe("insertAt")
    expect(check("a\nb", result)).toBe("a\nx\nb")
  })

  test("applyEditStrategy dispatches delete:true to range removal", () => {
    const result = applyEditStrategy("a\nb\nc", { startLine: 2, endLine: 2, delete: true, oldText: "b" })
    expect(result.strategy).toBe("delete")
    expect(check("a\nb\nc", result)).toBe("a\nc")
  })

  test("replacement adopts the LAST replaced line's terminator", () => {
    const before = "one\ntwo\nthree\r\nfour\n"
    const result = replaceLines(before, 2, 3, "TWO\nTHREE", "two")
    const after = check(before, result)
    // Line 3 ended CRLF, so the whole replacement is CRLF; lines 1 and 4 keep
    // their exact bytes.
    expect(after).toBe("one\nTWO\r\nTHREE\r\nfour\n")
  })

  test("replacement terminators are inferred locally without rewriting untouched mixed endings", () => {
    const before = "one\ntwo\r\nthree\r\nfour\n"
    const start = before.indexOf("two")
    const end = before.indexOf("\r\nfour")
    const replacement = adaptReplacementTerminators(before, start, end, "TWO\nTHREE")

    // The replaced block had CRLF internally and its boundary line also ends
    // CRLF. The unrelated LF lines before/after remain byte-identical.
    expect(replacement).toBe("TWO\r\nTHREE")
    expect(before.slice(0, start) + replacement + before.slice(end)).toBe("one\nTWO\r\nTHREE\r\nfour\n")
  })

  test("replacement preserves per-line mixed terminators positionally when line counts align", () => {
    const before = "a\nb\r\nc\nd\r\n"
    const start = before.indexOf("b")
    const end = before.indexOf("\r\n", before.indexOf("d")) + 2
    const replacement = adaptReplacementTerminators(before, start, end, "B\nC\nD\n")

    expect(replacement).toBe("B\r\nC\nD\r\n")
  })

  test("exact replacement auto-heals newline encoding from the matched region", () => {
    const before = "lf-before\nbefore\r\nrest\r\nlf-after\n"
    const result = resolveReplacement(before, "before\nrest", "after\nrest")

    expect(result.via).toBe("exact")
    expect(applySpans(before, result.spans)).toBe("lf-before\nafter\r\nrest\r\nlf-after\n")
  })

  test("replaceAll auto-heals each mixed-EOL match independently", () => {
    const before = "a\nb\n--\r\na\r\nb\r\n"
    const result = resolveReplacement(before, "a\nb", "x\ny", true)

    expect(result.applied).toBe(2)
    expect(applySpans(before, result.spans)).toBe("x\ny\n--\r\nx\r\ny\r\n")
  })

  test("unicode-equivalent needles resolve with a warning", () => {
    const before = "const name = \"value\"\n"
    const resolution = resolveMatch(before, "const name = \u201cvalue\u201d")
    expect(resolution.match.via).toBe("unicode-equivalent")
    expect(resolution.warnings).toHaveLength(1)
    expect(resolution.match.start).toBe(0)
  })
})

describe("edit input rails (pure)", () => {
  test("stripReadPrefix fires only when every line carries a prefix", () => {
    const healed = stripReadPrefix("12: const a = 1\n13: const b = 2")
    expect(healed.value).toBe("const a = 1\nconst b = 2")
    expect(healed.warnings).toHaveLength(1)
    expect(stripReadPrefix("const a = 1\n42: not a prefix").value).toBe("const a = 1\n42: not a prefix")
    expect(stripReadPrefix("").warnings).toHaveLength(0)
  })

  test("stripCodeFence removes a wrapping fence", () => {
    const healed = stripCodeFence("```ts\nconst a = 1\n```")
    expect(healed.value).toBe("const a = 1")
    expect(healed.warnings).toHaveLength(1)
    expect(stripCodeFence("const a = 1").value).toBe("const a = 1")
  })

  test("healInput strips fences and prefixes with kind labels", () => {
    const healed = healInput("```ts\n1: const a = 1\n2: const b = 2\n```", "newString")
    expect(healed.value).toBe("const a = 1\nconst b = 2")
    expect(healed.warnings.join("\n")).toContain("newString")
  })

  test("absorbDeletionNewline extends a deletion over the following terminator", () => {
    expect(absorbDeletionNewline("a\nb\n", { start: 0, end: 1, replacement: "" }).value).toEqual({
      start: 0,
      end: 2,
      replacement: "",
    })
    expect(absorbDeletionNewline("a\r\nb\r\n", { start: 0, end: 1, replacement: "" }).value.end).toBe(3)
    // Already ends with a newline, or a non-deletion: untouched.
    expect(absorbDeletionNewline("a\nb\n", { start: 0, end: 2, replacement: "" }).value.end).toBe(2)
    expect(absorbDeletionNewline("a\nb\n", { start: 0, end: 1, replacement: "x" }).value.end).toBe(1)
  })
})

describe("prior-read enforcement (pure)", () => {
  const sessionA = "ses-a"
  const sessionB = "ses-b"
  const staleAfs = {
    stat: () => Effect.succeed({ type: "File", mtime: Option.some(new Date(5000)), size: 5 }),
  } as never

  test("refuses files changed outside the session after they were read", async () => {
    const cache = new ReadCache()
    cache.recordRead(sessionA, "/f.txt", 1000, 5)
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionA, "/f.txt", "line"))
    expect(outcome.refusal).toContain("outside the current session")
  })

  test("same-session writes advance freshness without forcing a re-read", async () => {
    const cache = new ReadCache()
    cache.recordRead(sessionA, "/f.txt", 1000, 5)
    cache.recordWrite(sessionA, "/f.txt", 5000, 5)
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionA, "/f.txt", "line"))
    expect(outcome).toEqual({})
  })

  test("one session cannot advance another session's freshness", async () => {
    const cache = new ReadCache()
    cache.recordRead(sessionB, "/f.txt", 1000, 5)
    cache.recordWrite(sessionA, "/f.txt", 5000, 5)
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionB, "/f.txt", "exact"))
    expect(outcome.refusal).toContain("outside the current session")
  })

  test("same-session write without a read preserves line-grounding warning", async () => {
    const cache = new ReadCache()
    cache.recordWrite(sessionA, "/f.txt", 5000, 5)
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionA, "/f.txt", "line"))
    expect(outcome.refusal).toBeUndefined()
    expect(outcome.warning).toContain("only been written, not read")
  })

  test("warns (not refuses) on missing records for line-targeted strategies", async () => {
    const cache = new ReadCache()
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionA, "/never.txt", "line"))
    expect(outcome.refusal).toBeUndefined()
    expect(outcome.warning).toContain("no read record")
  })

  test("stays silent on missing records for the exact path", async () => {
    const cache = new ReadCache()
    const outcome = await Effect.runPromise(enforcePriorRead(Option.some(cache), staleAfs, sessionA, "/never.txt", "exact"))
    expect(outcome).toEqual({})
  })

  test("degrades to silence without a cache", async () => {
    const outcome = await Effect.runPromise(enforcePriorRead(Option.none(), staleAfs, sessionA, "/f.txt", "line"))
    expect(outcome).toEqual({})
  })
})

describe("patch rollback (pure)", () => {
  test("withRollback restores the journal in reverse on failure", async () => {
    const writes: Array<[string, string]> = []
    const removed: string[] = []
    const stub = {
      writeWithDirs: (p: string, c: string) =>
        Effect.sync(() => {
          writes.push([p, c])
        }),
      remove: (p: string) =>
        Effect.sync(() => {
          removed.push(p)
        }),
    } as never
    const error = await Effect.runPromise(
      Effect.flip(
        withRollback(
          stub,
          [
            { filePath: "/a.txt", existedBefore: true, contentBefore: "old-a", bom: false },
            { filePath: "/b.txt", existedBefore: false, contentBefore: "", bom: false },
          ],
          Effect.fail(new Error("boom")),
        ),
      ),
    )
    expect(error.message).toBe("boom")
    expect(removed).toEqual(["/b.txt"])
    expect(writes).toEqual([["/a.txt", "old-a"]])
  })

  test("withRollback passes success through untouched", async () => {
    const stub = {
      writeWithDirs: () => Effect.void,
      remove: () => Effect.void,
    } as never
    const result = await Effect.runPromise(withRollback(stub, [], Effect.succeed("ok")))
    expect(result).toBe("ok")
  })
})

// ---- integration tests through the tool execute ---------------------------

describe("tool.edit safety rails (integration)", () => {
  it.instance("no-op strategy returns applied=0 and never writes/asks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "line1\nline2\nline3")
      let asked = 0
      const result = yield* run(
        { filePath: filepath, line: 2, newText: "line2", oldText: "line2" },
        { ...ctx, ask: () => Effect.sync(() => { asked++ }) },
      )
      expect(result.metadata.applied).toBe(0)
      expect(asked).toBe(0)
      expect(yield* load(filepath)).toBe("line1\nline2\nline3")
    }),
  )

  it.instance("line strategy replaces a line and reports the diff", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\ngamma")
      const result = yield* run({ filePath: filepath, line: 2, newText: "BETA", oldText: "beta" })
      expect(result.output).toContain("strategy=line")
      expect(result.metadata.strategy).toBe("line")
      expect(result.metadata.oldPreview).toBe("beta")
      expect(yield* load(filepath)).toBe("alpha\nBETA\ngamma")
    }),
  )

  it.instance("same-session sequential edits do not require a redundant re-read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "same-session.txt")
      yield* put(filepath, "alpha\nbeta\ngamma")
      const afs = yield* FSUtil.Service
      const before = yield* afs.stat(filepath)
      globalReadCache.recordRead(
        ctx.sessionID,
        filepath,
        Option.getOrElse(before.mtime, () => new Date(0)).getTime(),
        Number(before.size),
      )

      yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })
      const afterFirst = yield* afs.stat(filepath)
      const tracked = globalReadCache.get(ctx.sessionID, filepath)
      expect(tracked?.mtimeMs).toBe(Option.getOrElse(afterFirst.mtime, () => new Date(0)).getTime())
      expect(tracked?.size).toBe(Number(afterFirst.size))
      const result = yield* run({ filePath: filepath, oldString: "gamma", newString: "GAMMA" })

      expect(result.output).toContain("Edit applied successfully")
      expect(yield* load(filepath)).toBe("ALPHA\nbeta\nGAMMA")
    }),
  )

  it.instance("a different session still gets a stale-file refusal", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "cross-session.txt")
      yield* put(filepath, "alpha\nbeta\ngamma")
      const afs = yield* FSUtil.Service
      const before = yield* afs.stat(filepath)
      const other = SessionID.make("ses_test-edit-other")
      globalReadCache.recordRead(
        other,
        filepath,
        Option.getOrElse(before.mtime, () => new Date(0)).getTime(),
        Number(before.size),
      )

      yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })
      const err = yield* fail(
        { filePath: filepath, oldString: "gamma", newString: "GAMMA" },
        { ...ctx, sessionID: other },
      )

      expect(err.message).toContain("outside the current session")
      expect(yield* load(filepath)).toBe("ALPHA\nbeta\ngamma")
    }),
  )

  it.instance("line strategy requires oldText", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\ngamma")
      const err = yield* fail({ filePath: filepath, line: 2, newText: "x" })
      expect(err.message).toContain("requires oldText")
      expect(yield* load(filepath)).toBe("alpha\nbeta\ngamma")
    }),
  )

  it.instance("line strategy rejects when oldText does not match (R4)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\ngamma")
      const err = yield* fail({ filePath: filepath, line: 2, newText: "x", oldText: "zzz" })
      expect(err.message).toContain("does not contain the expected text")
      expect(yield* load(filepath)).toBe("alpha\nbeta\ngamma")
    }),
  )

  it.instance("range strategy requires both bounds and rejects wide unanchored ranges", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n"))
      const err = yield* fail({ filePath: filepath, startLine: 1, newText: "x" })
      expect(err.message).toContain("both startLine and endLine")
      const wide = yield* fail({ filePath: filepath, startLine: 1, endLine: 8, newText: "x" })
      expect(wide.message).toContain("requires oldText")
      expect(yield* load(filepath)).toBe(Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n"))
    }),
  )

  it.instance("range strategy applies a verified wide range", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n"))
      const endpoints = ["line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
      yield* run({ filePath: filepath, startLine: 2, endLine: 7, newText: "middle", oldText: endpoints })
      expect(yield* load(filepath)).toBe("line1\nmiddle\nline8")
    }),
  )

  it.instance("delete strategy removes the range", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "keep\nremove me\nalso keep\n")
      yield* run({ filePath: filepath, startLine: 2, endLine: 2, delete: true, oldText: "remove me" })
      expect(yield* load(filepath)).toBe("keep\nalso keep\n")
    }),
  )

  it.instance("insertAt:0 prepends a file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "body\n")
      yield* run({ filePath: filepath, insertAt: 0, newText: "header" })
      expect(yield* load(filepath)).toBe("header\nbody\n")
    }),
  )

  it.instance("insertAt requires oldText for non-zero lines", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "a\nb\n")
      const err = yield* fail({ filePath: filepath, insertAt: 1, newText: "x" })
      expect(err.message).toContain("requires oldText")
      expect(yield* load(filepath)).toBe("a\nb\n")
    }),
  )

  it.instance("appendFile appends at EOF, never prepends (R7 regression)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "first")
      yield* run({ filePath: filepath, appendFile: true, newText: "second" })
      expect(yield* load(filepath)).toBe("first\nsecond")
    }),
  )

  it.instance("nearText strategy rejects a missing anchor (R6)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta")
      const err = yield* fail({ filePath: filepath, nearText: "zzz", oldText: "alpha", newText: "x" })
      expect(err.message).toContain("anchor not found")
      expect(yield* load(filepath)).toBe("alpha\nbeta")
    }),
  )

  it.instance("nearText strategy rejects an ambiguous oldText (R3) listing candidates", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, ["anchor", "old", "middle", "old", "tail"].join("\n"))
      const err = yield* fail({ filePath: filepath, nearText: "anchor", oldText: "old", newText: "new" })
      expect(err.message).toContain("multiple lines")
      expect(yield* load(filepath)).toBe(["anchor", "old", "middle", "old", "tail"].join("\n"))
    }),
  )

  it.instance("batch edit is atomic: one bad op leaves the file untouched (R9)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      const original = "one\ntwo\nthree"
      yield* put(filepath, original)
      const err = yield* fail({
        filePath: filepath,
        edits: [{ line: 1, newText: "ONE", oldText: "one" }, { oldString: "not in file", newString: "x" }],
      })
      expect(err).toBeInstanceOf(Error)
      expect(yield* load(filepath)).toBe(original)
    }),
  )

  it.instance("batch edit applies valid edits under one write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "one\ntwo\nthree")
      yield* run({
        filePath: filepath,
        edits: [
          { line: 1, newText: "ONE", oldText: "one" },
          { oldString: "three", newString: "THREE" },
        ],
      })
      expect(yield* load(filepath)).toBe("ONE\ntwo\nTHREE")
    }),
  )

  it.instance("preserves line endings and BOM across strategies", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.cs")
      const bom = String.fromCharCode(0xfeff)
      yield* put(filepath, `${bom}line1\r\nline2\r\nline3`)
      yield* run({ filePath: filepath, line: 2, newText: "LINE2", oldText: "line2" })
      const raw = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(raw.charCodeAt(0)).toBe(0xfeff)
      expect(raw).toBe(`${bom}line1\r\nLINE2\r\nline3`)
    }),
  )

  it.instance("exact path behavior is unchanged alongside new params", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "old content here")
      const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })
      expect(result.output).toContain("Edit applied successfully")
      expect(result.metadata.strategy).toBe("exact")
      expect(yield* load(filepath)).toBe("new content here")
    }),
  )

  it.instance("rejects line out-of-range with the file's line count", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "a\nb")
      const err = yield* fail({ filePath: filepath, line: 99, newText: "x", oldText: "y" })
      expect(err.message).toContain("out of range")
    }),
  )

  it.instance("re-validates when the file changes during approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "target = 1\nother = 2\n")
      const mutatingAsk = () =>
        Effect.promise(() => fs.appendFile(filepath, "unrelated = 3\n")).pipe(Effect.asVoid)
      const result = yield* run({ filePath: filepath, oldString: "target = 1", newString: "target = 9" }, { ...ctx, ask: mutatingAsk })
      expect(result.output).toContain("re-validated")
      expect(yield* load(filepath)).toBe("target = 9\nother = 2\nunrelated = 3\n")
    }),
  )

  it.instance("refuses when the target itself changed during approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "target = 1\nother = 2\n")
      // Note: the mutation must not contain the needle even as a substring —
      // "target = 100" still contains "target = 1" and would exactly match.
      const mutatingAsk = () => Effect.promise(() => fs.writeFile(filepath, "target = 200\nother = 2\n")).pipe(Effect.asVoid)
      const err = yield* fail(
        { filePath: filepath, oldString: "target = 1", newString: "target = 9" },
        { ...ctx, ask: mutatingAsk },
      )
      expect(err.message).toContain("Could not find oldString")
      // Nothing was discarded: the external change stands, ours was refused.
      expect(yield* load(filepath)).toBe("target = 200\nother = 2\n")
    }),
  )

  it.instance("same session can edit its own freshly-mutated file without a redundant re-read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "same-session.txt")
      yield* put(filepath, "alpha\nbeta\ngamma\n")
      const fsutil = yield* FSUtil.Service
      const stat = yield* fsutil.stat(filepath)
      globalReadCache.recordRead(
        ctx.sessionID,
        filepath,
        Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
        Number(stat.size),
      )

      yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })
      const second = yield* run({ filePath: filepath, oldString: "gamma", newString: "GAMMA" })

      expect(second.output).toContain("Edit applied successfully")
      expect(yield* load(filepath)).toBe("ALPHA\nbeta\nGAMMA\n")
    }),
  )

  it.instance("a write from another session still invalidates this session's grounding", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "cross-session.txt")
      yield* put(filepath, "alpha\nbeta\n")
      const fsutil = yield* FSUtil.Service
      const stat = yield* fsutil.stat(filepath)
      const other = SessionID.make("ses_other-edit-session")
      globalReadCache.recordRead(
        other,
        filepath,
        Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
        Number(stat.size),
      )

      yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })
      const err = yield* fail(
        { filePath: filepath, oldString: "beta", newString: "BETA" },
        { ...ctx, sessionID: other },
      )

      expect(err.message).toContain("outside the current session")
      expect(yield* load(filepath)).toBe("ALPHA\nbeta\n")
    }),
  )
})
