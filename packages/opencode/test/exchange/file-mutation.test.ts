import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeError } from "../../src/exchange/error"
import { ExchangeFileMutation } from "../../src/exchange/file-mutation"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

function failure(method: string) {
  return new FSUtil.FileSystemError({ method, cause: new Error("injected uncertain filesystem result") })
}

function update(pathname: string, before: string, after: string): ExchangeFileMutation.Change {
  return {
    type: "update",
    path: pathname,
    displayPath: "/repo/a.txt",
    beforeExists: true,
    before: new TextEncoder().encode(before),
    after: new TextEncoder().encode(after),
  }
}

function commit(fs: FSUtil.Interface, change: ExchangeFileMutation.Change) {
  return ExchangeFileMutation.commit(fs, [change.type === "move" ? change.movePath : change.path, change.path], {
    prepare: () => Effect.succeed({ changes: [change], value: undefined }),
    revalidate: () => Effect.void,
    beforeCommit: () => Effect.void,
  })
}

describe("ExchangeFileMutation", () => {
  it.live("restores an update when rename became visible before reporting failure", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const target = path.join(tmp.path, "a.txt")
    yield* Effect.promise(() => fs.writeFile(target, "before\n"))
    const actual = yield* FSUtil.Service
    let failNextRename = true
    const uncertain = FSUtil.Service.of({
      ...actual,
      rename: (from, to) => {
        if (!failNextRename) return actual.rename(from, to)
        failNextRename = false
        return actual.rename(from, to).pipe(Effect.andThen(Effect.fail(failure("rename"))))
      },
    })

    const error = yield* commit(uncertain, update(target, "before\n", "after\n")).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.DependencyUnavailable)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
  }))

  it.live("restores a delete when removal became visible before reporting failure", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const target = path.join(tmp.path, "a.txt")
    yield* Effect.promise(() => fs.writeFile(target, "before\n"))
    const actual = yield* FSUtil.Service
    let failDelete = true
    const uncertain = FSUtil.Service.of({
      ...actual,
      remove: (pathname, options) => {
        if (pathname !== target || !failDelete) return actual.remove(pathname, options)
        failDelete = false
        return actual.remove(pathname, options).pipe(Effect.andThen(Effect.fail(failure("remove"))))
      },
    })
    const change: ExchangeFileMutation.Change = {
      type: "delete",
      path: target,
      displayPath: "/repo/a.txt",
      beforeExists: true,
      before: new TextEncoder().encode("before\n"),
    }

    const error = yield* commit(uncertain, change).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.DependencyUnavailable)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
  }))

  it.live("reconciles a partial move whose source removal became visible before failure", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const source = path.join(tmp.path, "a.txt")
    const destination = path.join(tmp.path, "b.txt")
    yield* Effect.promise(() => fs.writeFile(source, "before\n"))
    const actual = yield* FSUtil.Service
    let failSourceRemove = true
    const uncertain = FSUtil.Service.of({
      ...actual,
      remove: (pathname, options) => {
        if (pathname !== source || !failSourceRemove) return actual.remove(pathname, options)
        failSourceRemove = false
        return actual.remove(pathname, options).pipe(Effect.andThen(Effect.fail(failure("remove"))))
      },
    })
    const change: ExchangeFileMutation.Change = {
      type: "move",
      path: source,
      displayPath: "/repo/a.txt",
      movePath: destination,
      moveDisplayPath: "/repo/b.txt",
      beforeExists: true,
      before: new TextEncoder().encode("before\n"),
      after: new TextEncoder().encode("after\n"),
    }

    const error = yield* commit(uncertain, change).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.DependencyUnavailable)
    expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("before\n")
    expect(yield* Effect.promise(() => fs.stat(destination).then(() => true, () => false))).toBe(false)
  }))

  it.live("preserves the destination when a partial move cannot restore its removed source", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const source = path.join(tmp.path, "a.txt")
    const destination = path.join(tmp.path, "b.txt")
    yield* Effect.promise(() => fs.writeFile(source, "before\n"))
    const actual = yield* FSUtil.Service
    let failSourceRemove = true
    let renameCount = 0
    const uncertain = FSUtil.Service.of({
      ...actual,
      rename: (from, to) => {
        renameCount++
        // First rename publishes the move destination. The second rename is
        // rollback trying to restore the removed source.
        if (renameCount === 2) return Effect.fail(failure("restore-source"))
        return actual.rename(from, to)
      },
      remove: (pathname, options) => {
        if (pathname !== source || !failSourceRemove) return actual.remove(pathname, options)
        failSourceRemove = false
        return actual.remove(pathname, options).pipe(Effect.andThen(Effect.fail(failure("remove-source"))))
      },
    })
    const change: ExchangeFileMutation.Change = {
      type: "move",
      path: source,
      displayPath: "/repo/a.txt",
      movePath: destination,
      moveDisplayPath: "/repo/b.txt",
      beforeExists: true,
      before: new TextEncoder().encode("before\n"),
      after: new TextEncoder().encode("after\n"),
    }

    const error = yield* commit(uncertain, change).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    expect(yield* Effect.promise(() => fs.stat(source).then(() => true, () => false))).toBe(false)
    expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toBe("after\n")
  }))

  it.live("returns AMBIGUOUS_COMMIT when rollback itself cannot be proven", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const target = path.join(tmp.path, "a.txt")
    yield* Effect.promise(() => fs.writeFile(target, "before\n"))
    const actual = yield* FSUtil.Service
    let renameCount = 0
    const uncertain = FSUtil.Service.of({
      ...actual,
      rename: (from, to) => {
        renameCount++
        if (renameCount === 1) {
          return actual.rename(from, to).pipe(Effect.andThen(Effect.fail(failure("rename-visible"))))
        }
        if (renameCount === 2) return Effect.fail(failure("rollback-rename"))
        return actual.rename(from, to)
      },
    })

    const error = yield* commit(uncertain, update(target, "before\n", "after\n")).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    expect(String(error)).toContain("rollback operation failed")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
  }))

  it.live("never overwrites an unrecognized newer state after an uncertain write", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const target = path.join(tmp.path, "a.txt")
    yield* Effect.promise(() => fs.writeFile(target, "before\n"))
    const actual = yield* FSUtil.Service
    let injected = false
    const uncertain = FSUtil.Service.of({
      ...actual,
      rename: (from, to) => {
        if (injected) return actual.rename(from, to)
        injected = true
        return actual.rename(from, to).pipe(
          Effect.andThen(actual.writeFileString(to, "newer\n")),
          Effect.andThen(Effect.fail(failure("rename-newer"))),
        )
      },
    })

    const error = yield* commit(uncertain, update(target, "before\n", "after\n")).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    expect(String(error)).toContain("unrecognized/newer state")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
  }))
})

