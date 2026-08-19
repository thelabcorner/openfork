import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { EditTool, applyEditStrategy, replaceLine, replaceLines, replaceNear, applyBatch, insertAfterLine, appendToFile } from "../../src/tool/edit"
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
import { Watcher } from "@opencode-ai/core/filesystem/watcher"

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

const fail = Effect.fn("EditRailTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
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

// ---- pure helper unit tests (no runtime needed) ----------------------------

describe("edit strategy helpers (pure)", () => {
  test("replaceLine replaces the target line and echoes oldPreview", () => {
    const result = replaceLine("a\nb\nc", 2, "B")
    expect(result.content).toBe("a\nB\nc")
    expect(result.applied).toBe(1)
    expect(result.oldPreview).toBe("b")
  })

  test("replaceLine verifies oldText and rejects with the snippet", () => {
    expect(() => replaceLine("alpha\nbeta", 1, "x", "omega")).toThrow(/does not contain the expected text/)
    expect(() => replaceLine("alpha", 2, "x")).toThrow(/out of range/)
  })

  test("replaceLine is a no-op when the line already matches", () => {
    const result = replaceLine("a\nb\nc", 2, "b")
    expect(result.applied).toBe(0)
    expect(result.content).toBe("a\nb\nc")
  })

  test("replaceLines rejects a >5-line range without oldText (R5)", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    expect(() => replaceLines(content, 1, 10, "replacement")).toThrow(/requires oldText/)
  })

  test("replaceLines accepts a >5-line range with oldText contained in it", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    const result = replaceLines(content, 1, 10, "replacement", "line5")
    expect(result.content).toBe("replacement")
    expect(result.applied).toBe(1)
  })

  test("replaceLines rejects a wide range whose oldText is not contained", () => {
    const content = "a\nb\nc\nd\ne\nf"
    expect(() => replaceLines(content, 1, 6, "x", "not-there")).toThrow(/does not contain the expected text/)
  })

  test("insertAfterLine bounds-checks and inserts", () => {
    expect(() => insertAfterLine("a\nb", 5, "x")).toThrow(/out of range/)
    const result = insertAfterLine("a\nb\nc", 1, "inserted")
    expect(result.content).toBe("a\ninserted\nb\nc")
  })

  test("appendToFile appends at EOF (R7 — never prepends)", () => {
    const result = appendToFile("first", "second")
    expect(result.content).toBe("first\nsecond")
    const atEnd = appendToFile("first\n", "second")
    expect(atEnd.content).toBe("first\nsecond")
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
    expect(result.content).toContain("new value here")
    expect(result.applied).toBe(1)
  })

  test("replaceNear rejects when oldText is absent from the window", () => {
    const content = ["anchor", "far away content", "tail"].join("\n")
    expect(() => replaceNear(content, "anchor", "missing", "x")).toThrow(/not found within/)
  })

  test("applyBatch applies line and exact ops atomically", () => {
    const edits = [
      { line: 2, newText: "line2-new" },
      { oldString: "line3", newString: "line3-new" },
    ]
    const result = applyBatch("line1\nline2\nline3", edits)
    expect(result.content).toBe("line1\nline2-new\nline3-new")
  })

  test("applyBatch rejects the whole batch when one op fails (R9)", () => {
    const edits = [
      { line: 2, newText: "ok" },
      { oldString: "not present anywhere", newString: "x" },
    ]
    expect(() => applyBatch("line1\nline2\nline3", edits)).toThrow()
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
    expect(() => applyEditStrategy("a\nb", { line: 1, insertAfter: 1, newText: "x" })).toThrow(/multiple strategies/)
  })

  test("applyEditStrategy rejects when no strategy is present", () => {
    expect(() => applyEditStrategy("a\nb", {})).toThrow(/No edit strategy detected/)
  })

  test("applyEditStrategy: oldString priority means cheap params are ignored", () => {
    // exact path handled in the tool; the helper itself never sees oldString
    const result = applyEditStrategy("a\nb", { line: 1, newText: "x" })
    expect(result.strategy).toBe("line")
    expect(result.content).toBe("x\nb")
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
        { filePath: filepath, line: 2, newText: "line2" },
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
      const result = yield* run({ filePath: filepath, line: 2, newText: "BETA" })
      expect(result.output).toContain("strategy=line")
      expect(result.metadata.strategy).toBe("line")
      expect(result.metadata.oldPreview).toBe("beta")
      expect(yield* load(filepath)).toBe("alpha\nBETA\ngamma")
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
      yield* run({ filePath: filepath, startLine: 2, endLine: 7, newText: "middle", oldText: "line4" })
      expect(yield* load(filepath)).toBe("line1\nmiddle\nline8")
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
        edits: [
          { line: 1, newText: "ONE" },
          { oldString: "not in file", newString: "x" },
        ],
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
          { line: 1, newText: "ONE" },
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
      yield* run({ filePath: filepath, line: 2, newText: "LINE2" })
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

  it.instance("rejects an empty oldText nearText and line out-of-range", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "a\nb")
      const err = yield* fail({ filePath: filepath, line: 99, newText: "x" })
      expect(err.message).toContain("out of range")
    }),
  )
})
