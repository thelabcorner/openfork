import { describe, expect } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeAttribution } from "../../src/exchange/attribution"
import { ExchangeError } from "../../src/exchange/error"
import { ExchangeFileMutation } from "../../src/exchange/file-mutation"
import { ExchangeRead } from "../../src/exchange/read"
import { ExchangeWrite } from "../../src/exchange/write"
import { tmpdir } from "../fixture/fixture"
import { drainCodingActivity, subscribeCodingActivity } from "../lib/coding-activity"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

const withTmp = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const encode = (text: string) => new TextEncoder().encode(text)

/** Creates a nested directory under the temp root and writes a file inside it. */
const nestedFile = (root: string, ...segments: string[]) =>
  Effect.gen(function* () {
    const target = path.join(root, ...segments)
    yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }))
    yield* Effect.promise(() => Bun.write(target, "bravo\n"))
    return target
  })
const hooks = { revalidate: () => Effect.void, beforeCommit: () => Effect.void }

/**
 * A trusted boundary that proved an approved root on disk. The folder is the
 * canonical root it re-verified, which is what may become a project folder; the
 * display name and the principal key are separate fields entirely.
 */
const attributionFor = (projectFolder: string): ExchangeAttribution.Attribution => ({
  source: "ofxp",
  project: "canonical-project",
  projectFolder,
  sourceRef: "ofxp:peer:principal",
})

const update = (target: string, displayPath: string, before: string, after: string): ExchangeFileMutation.Change => ({
  type: "update",
  path: target,
  displayPath,
  beforeExists: true,
  before: encode(before),
  after: encode(after),
})

describe("exchange coding activity", () => {
  it.live("ExchangeFileMutation.commit records one write per committed change", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const target = path.join(dir, "a.txt")
        yield* Effect.promise(() => Bun.write(target, "one\ntwo\nthree\n"))
        const log = yield* subscribeCodingActivity

        const result = yield* ExchangeFileMutation.commit(fs, [target], {
          prepare: () =>
            Effect.succeed({
              changes: [update(target, "a.txt", "one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n")],
              value: undefined,
            }),
          revalidate: () => Effect.void,
          beforeCommit: () => Effect.void,
        })
        expect(result.committed).toBe(true)

        const events = yield* drainCodingActivity(log, "mutation-commit")
        const mine = events.filter((event) => event.entity === target)
        expect(mine).toHaveLength(1)
        expect(mine[0]!.kind).toBe("write")
        expect(mine[0]!.aiLineChanges).toBe(1)
        expect(mine[0]!.source).toBe("core")
        expect(mine[0]!.project).toBe(path.basename(dir))
      }),
    ),
  )

  it.live("ExchangeFileMutation records nothing for empty plans or conflicts", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const target = path.join(dir, "a.txt")
        yield* Effect.promise(() => Bun.write(target, "current\n"))
        const log = yield* subscribeCodingActivity

        const empty = yield* ExchangeFileMutation.commit(fs, [target], {
          prepare: () => Effect.succeed({ changes: [], value: undefined }),
          revalidate: () => Effect.void,
          beforeCommit: () => Effect.void,
        })
        expect(empty.committed).toBe(false)
        expect(empty.changes).toHaveLength(0)

        // A stale `before` fails the pre-commit CAS. The strict whole-plan
        // commit rejects the call, so nothing may be written and nothing may
        // be recorded.
        const conflicted = yield* ExchangeFileMutation.commit(fs, [target], {
          prepare: () => Effect.succeed({ changes: [update(target, "a.txt", "stale\n", "after\n")], value: undefined }),
          revalidate: () => Effect.void,
          beforeCommit: () => Effect.void,
        }).pipe(Effect.flip)
        expect(conflicted).toBeInstanceOf(ExchangeError.Conflict)
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("current\n")

        const events = yield* drainCodingActivity(log, "mutation-none")
        expect(events.filter((event) => event.entity === target)).toEqual([])
      }),
    ),
  )

  it.live("ExchangeFileMutation records deletes at the source and moves at the destination", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const doomed = path.join(dir, "doomed.txt")
        const source = path.join(dir, "source.txt")
        const destination = path.join(dir, "destination.txt")
        yield* Effect.promise(() => Bun.write(doomed, "one\ntwo\n"))
        yield* Effect.promise(() => Bun.write(source, "moved\n"))
        const log = yield* subscribeCodingActivity
        const changes: ExchangeFileMutation.Change[] = [
          { type: "delete", path: doomed, displayPath: "doomed.txt", beforeExists: true, before: encode("one\ntwo\n") },
          {
            type: "move",
            path: source,
            displayPath: "source.txt",
            movePath: destination,
            moveDisplayPath: "destination.txt",
            beforeExists: true,
            before: encode("moved\n"),
            after: encode("moved\nappended\n"),
          },
        ]

        const result = yield* ExchangeFileMutation.commit(fs, [doomed, source, destination], {
          prepare: () => Effect.succeed({ changes, value: undefined }),
          revalidate: () => Effect.void,
          beforeCommit: () => Effect.void,
        })
        expect(result.committed).toBe(true)

        const events = yield* drainCodingActivity(log, "mutation-shapes")
        expect(events.find((event) => event.entity === doomed)?.aiLineChanges).toBe(-2)
        expect(events.find((event) => event.entity === destination)?.aiLineChanges).toBe(1)
        expect(events.find((event) => event.entity === source)).toBeUndefined()
      }),
    ),
  )

  it.live("ExchangeWrite records only committed writes", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const target = path.join(dir, "written.txt")
        const log = yield* subscribeCodingActivity

        const first = yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "written.txt", content: "hello\nworld\n" },
          hooks,
        )
        expect(first.mutation.committed).toBe(true)

        const second = yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "written.txt", content: "hello\nworld\n" },
          hooks,
        )
        expect(second.mutation.committed).toBe(false)

        const events = yield* drainCodingActivity(log, "write-commit")
        const mine = events.filter((event) => event.entity === target)
        expect(mine).toHaveLength(1)
        expect(mine[0]!.kind).toBe("write")
        expect(mine[0]!.aiLineChanges).toBe(2)
        expect(mine[0]!.source).toBe("core")
        expect(mine[0]!.project).toBe(path.basename(dir))
      }),
    ),
  )

  it.live("ExchangeRead records file reads but not directories or failed reads", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const target = path.join(dir, "readable.txt")
        const missing = path.join(dir, "missing.txt")
        yield* Effect.promise(() => Bun.write(target, "line one\nline two\n"))
        const log = yield* subscribeCodingActivity

        const file = yield* ExchangeRead.execute(fs, { path: target, displayPath: "readable.txt" }, hooks)
        expect(file.result.output).toContain("line one")

        const directory = yield* ExchangeRead.execute(fs, { path: dir, displayPath: "" }, hooks)
        expect(directory.result.metadata?.directory).toBe(true)

        const failure = yield* ExchangeRead.execute(fs, { path: missing, displayPath: "missing.txt" }, hooks).pipe(
          Effect.flip,
        )
        expect(failure).toBeInstanceOf(ExchangeRead.DependencyUnavailable)

        const events = yield* drainCodingActivity(log, "read-only")
        const mine = events.filter((event) => event.entity === target || event.entity === dir || event.entity === missing)
        expect(mine.map((event) => event.entity)).toEqual([target])
        expect(mine[0]!.kind).toBe("read")
        expect(mine[0]!.source).toBe("core")
        expect(mine[0]!.project).toBe(path.basename(dir))
      }),
    ),
  )

  it.live("a defective activity observer cannot fail a committed write", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const target = path.join(dir, "isolated.txt")
        yield* CodingActivity.stream().pipe(
          Stream.runForEach(() => Effect.die("activity observer exploded")),
          Effect.forkScoped,
        )
        yield* Effect.yieldNow

        const execution = yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "isolated.txt", content: "still written\n" },
          { revalidate: () => Effect.void },
        )
        expect(execution.mutation.committed).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("still written\n")
      }),
    ),
  )

  it.live("attribution retargets the existing record instead of adding a second one", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const attribution = attributionFor(dir)
        const mutated = path.join(dir, "a.txt")
        const written = path.join(dir, "b.txt")
        yield* Effect.promise(() => Bun.write(mutated, "one\ntwo\n"))
        const log = yield* subscribeCodingActivity

        // A public alias spelling is not a canonical project identity.
        yield* ExchangeFileMutation.commit(
          fs,
          [mutated],
          {
            prepare: () =>
              Effect.succeed({
                changes: [update(mutated, "alias/a.txt", "one\ntwo\n", "one\ntwo\nthree\n")],
                value: undefined,
              }),
            revalidate: () => Effect.void,
            beforeCommit: () => Effect.void,
          },
          undefined,
          attribution,
        )
        yield* ExchangeRead.execute(fs, { path: mutated, displayPath: "alias/a.txt", attribution }, hooks)
        const execution = yield* ExchangeWrite.execute(
          fs,
          { path: written, displayPath: "alias/b.txt", content: "x\ny\n", attribution },
          hooks,
        )
        expect(execution.mutation.committed).toBe(true)

        const events = yield* drainCodingActivity(log, "attributed")
        const mine = events.filter((event) => event.source === "ofxp")
        expect(mine.map((event) => event.entity).slice().sort()).toEqual([mutated, mutated, written].slice().sort())
        for (const event of mine) {
          expect(event.project).toBe("canonical-project")
          expect(event.projectFolder).toBe(dir)
          expect(event.sourceRef).toBe("ofxp:peer:principal")
        }
        expect(events.some((event) => event.project === "alias")).toBe(false)
        expect(events.some((event) => event.projectFolder?.includes("/alias/"))).toBe(false)
        expect(events.filter((event) => event.entity === mutated && event.kind === "write")).toHaveLength(1)
        expect(events.filter((event) => event.entity === mutated && event.kind === "read")).toHaveLength(1)
      }),
    ),
  )

  it.live("attributed empty plans, conflicts and no-op writes still record nothing", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const attribution = attributionFor(dir)
        const target = path.join(dir, "a.txt")
        const missing = path.join(dir, "missing.txt")
        yield* Effect.promise(() => Bun.write(target, "current\n"))
        const log = yield* subscribeCodingActivity

        const empty = yield* ExchangeFileMutation.commit(
          fs,
          [target],
          {
            prepare: () => Effect.succeed({ changes: [], value: undefined }),
            revalidate: () => Effect.void,
            beforeCommit: () => Effect.void,
          },
          undefined,
          attribution,
        )
        expect(empty.committed).toBe(false)

        const conflicted = yield* ExchangeFileMutation.commit(
          fs,
          [target],
          {
            prepare: () =>
              Effect.succeed({ changes: [update(target, "alias/a.txt", "stale\n", "after\n")], value: undefined }),
            revalidate: () => Effect.void,
            beforeCommit: () => Effect.void,
          },
          undefined,
          attribution,
        ).pipe(Effect.flip)
        expect(conflicted).toBeInstanceOf(ExchangeError.Conflict)
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("current\n")

        const noop = yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "alias/a.txt", content: "current\n", attribution },
          hooks,
        )
        expect(noop.mutation.committed).toBe(false)

        const failure = yield* ExchangeRead.execute(
          fs,
          { path: missing, displayPath: "alias/missing.txt", attribution },
          hooks,
        ).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(ExchangeRead.DependencyUnavailable)

        const events = yield* drainCodingActivity(log, "attributed-none")
        expect(events.filter((event) => event.source === "ofxp")).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("current\n")
      }),
    ),
  )

  it.live("attribution owns no count: committed deltas stay exact and reads stay count-free", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const attribution = attributionFor(dir)
        const target = path.join(dir, "a.txt")
        const log = yield* subscribeCodingActivity

        yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "alias/a.txt", content: "l1\nl2\nl3\n", attribution },
          hooks,
        )
        yield* ExchangeWrite.execute(
          fs,
          { path: target, displayPath: "alias/a.txt", content: "l1\n", attribution },
          hooks,
        )
        yield* ExchangeRead.execute(fs, { path: target, displayPath: "alias/a.txt", attribution }, hooks)

        const events = yield* drainCodingActivity(log, "attributed-counts")
        const writes = events.filter((event) => event.entity === target && event.kind === "write")
        expect(writes.map((event) => event.aiLineChanges)).toEqual([3, -2])
        const reads = events.filter((event) => event.entity === target && event.kind === "read")
        expect(reads).toHaveLength(1)
        expect(reads[0]!.aiLineChanges).toBeUndefined()
      }),
    ),
  )
})

describe("exchange project folder authority", () => {
  it.live("an unattributed producer names a project but never a directory", () =>
    // The kernel holds no root authority of its own: it receives an
    // already-authorized target and a public display path, and neither is a
    // directory. It must fail closed rather than derive one from the spelling.
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const atRoot = path.join(dir, "top.txt")
        yield* Effect.promise(() => Bun.write(atRoot, "alpha\n"))
        const nested = yield* nestedFile(dir, "pkg", "deep", "a.ts")
        const log = yield* subscribeCodingActivity

        yield* ExchangeRead.execute(fs, { path: atRoot, displayPath: "top.txt" }, hooks)
        yield* ExchangeRead.execute(fs, { path: nested, displayPath: "pkg/deep/a.ts" }, hooks)
        yield* ExchangeWrite.execute(
          fs,
          { path: atRoot, displayPath: "top.txt", content: "alpha\ncharlie\n" },
          hooks,
        )
        yield* ExchangeFileMutation.commit(fs, [atRoot], {
          prepare: () =>
            Effect.succeed({
              changes: [update(atRoot, "top.txt", "alpha\ncharlie\n", "delta\n")],
              value: undefined,
            }),
          revalidate: () => Effect.void,
          beforeCommit: () => Effect.void,
        })

        const events = yield* drainCodingActivity(log, "unattributed-folders")
        const mine = events.filter((event) => event.entity === atRoot || event.entity === nested)
        expect(mine.length).toBe(4)
        for (const event of mine) {
          // A display name is still produced, and it is still only a name.
          expect(event.project).toBe(path.basename(dir))
          expect(event.projectFolder).toBeUndefined()
        }
      }),
    ),
  )

  it.live("an attributed boundary supplies one canonical root for a root file and a nested file", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* Effect.promise(() => Bun.write(path.join(dir, "top.txt"), "alpha\n"))
        const nested = yield* nestedFile(dir, "pkg", "deep", "a.ts")
        const log = yield* subscribeCodingActivity

        // The boundary's root is the tmpdir; both display paths are public
        // aliases that disagree with it, exactly as a remote root would.
        const attribution = attributionFor(dir)
        yield* ExchangeRead.execute(fs, { path: path.join(dir, "top.txt"), displayPath: "alias/top.txt", attribution }, hooks)
        yield* ExchangeRead.execute(fs, { path: nested, displayPath: "alias/pkg/deep/a.ts", attribution }, hooks)
        yield* ExchangeFileMutation.commit(
          fs,
          [nested],
          {
            prepare: () =>
              Effect.succeed({
                changes: [update(nested, "alias/pkg/deep/a.ts", "bravo\n", "bravo\ncharlie\n")],
                value: undefined,
              }),
            revalidate: () => Effect.void,
            beforeCommit: () => Effect.void,
          },
          undefined,
          attribution,
        )

        const events = yield* drainCodingActivity(log, "attributed-folders")
        const mine = events.filter((event) => event.source === "ofxp")
        expect(mine).toHaveLength(3)
        expect([...new Set(mine.map((event) => event.projectFolder))]).toEqual([dir])
        for (const event of mine) {
          expect(path.isAbsolute(event.projectFolder!)).toBe(true)
        }
        // `pkg`/`deep` are real parent directory names, and the alias collides
        // with nothing: neither may stand in for the proven root.
        for (const leaked of ["pkg", "deep", "alias", "canonical-project"]) {
          expect(mine.map((event) => event.projectFolder)).not.toContain(leaked)
        }
      }),
    ),
  )
})
