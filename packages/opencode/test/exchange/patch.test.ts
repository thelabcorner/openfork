import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangePatch } from "../../src/exchange/patch"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

describe("ExchangePatch", () => {
  it.live("isolates a commit-time file race without discarding clean siblings", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const a = path.join(tmp.path, "a.txt")
    const b = path.join(tmp.path, "b.txt")
    const c = path.join(tmp.path, "c.txt")
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(a, "alpha\n"),
        fs.writeFile(b, "bravo\n"),
        fs.writeFile(c, "charlie\n"),
      ]),
    )
    const afs = yield* FSUtil.Service
    let raced = false

    const result = yield* ExchangePatch.execute(
      afs,
      {
        patchText: [
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          "-alpha",
          "+ALPHA",
          "*** Update File: b.txt",
          "@@",
          "-bravo",
          "+BRAVO",
          "*** Update File: c.txt",
          "@@",
          "-charlie",
          "+CHARLIE",
          "*** End Patch",
        ].join("\n"),
      },
      {
        resolve: (relativePath) =>
          Effect.succeed({
            path: path.join(tmp.path, relativePath),
            displayPath: `/workspace/${relativePath}`,
          }),
        revalidate: () =>
          raced
            ? Effect.void
            : afs.writeFileString(b, "bravo-raced\n").pipe(
                Effect.tap(() => Effect.sync(() => {
                  raced = true
                })),
                Effect.asVoid,
              ),
        beforeCommit: () => Effect.void,
      },
    )

    expect(result.result.mutation).toEqual({ attempted: true, committed: true })
    expect(result.result.metadata).toMatchObject({
      applied: true,
      fileCount: 2,
      conflicts: [{ path: "/workspace/b.txt", phase: "commit" }],
      resolution: { status: "partial", requested: 3, preflightReady: 3, applied: 2, satisfied: 0, conflicted: 1 },
    })
    expect(result.touched.map((touch) => touch.sourcePath).toSorted()).toEqual([a, c].toSorted())
    expect(yield* Effect.promise(() => fs.readFile(a, "utf8"))).toBe("ALPHA\n")
    expect(yield* Effect.promise(() => fs.readFile(b, "utf8"))).toBe("bravo-raced\n")
    expect(yield* Effect.promise(() => fs.readFile(c, "utf8"))).toBe("CHARLIE\n")
  }))

  it.live("keeps apply:true atomic when a file races at commit time", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const a = path.join(tmp.path, "a.txt")
    const b = path.join(tmp.path, "b.txt")
    const c = path.join(tmp.path, "c.txt")
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(a, "alpha\n"),
        fs.writeFile(b, "bravo\n"),
        fs.writeFile(c, "charlie\n"),
      ]),
    )
    const afs = yield* FSUtil.Service
    let raced = false

    const error = yield* ExchangePatch.execute(
      afs,
      {
        apply: true,
        patchText: [
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          "-alpha",
          "+ALPHA",
          "*** Update File: b.txt",
          "@@",
          "-bravo",
          "+BRAVO",
          "*** Update File: c.txt",
          "@@",
          "-charlie",
          "+CHARLIE",
          "*** End Patch",
        ].join("\n"),
      },
      {
        resolve: (relativePath) =>
          Effect.succeed({
            path: path.join(tmp.path, relativePath),
            displayPath: `/workspace/${relativePath}`,
          }),
        revalidate: () =>
          raced
            ? Effect.void
            : afs.writeFileString(b, "bravo-raced\n").pipe(
                Effect.tap(() => Effect.sync(() => {
                  raced = true
                })),
                Effect.asVoid,
              ),
        beforeCommit: () => Effect.void,
      },
    ).pipe(Effect.flip)

    expect(error._tag).toBe("Exchange.Conflict")
    if (error._tag === "Exchange.Conflict") {
      expect(error.detail).toContain("/workspace/b.txt changed before commit")
    }
    expect(yield* Effect.promise(() => fs.readFile(a, "utf8"))).toBe("alpha\n")
    expect(yield* Effect.promise(() => fs.readFile(b, "utf8"))).toBe("bravo-raced\n")
    expect(yield* Effect.promise(() => fs.readFile(c, "utf8"))).toBe("charlie\n")
  }))
})
