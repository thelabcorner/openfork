import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { searchBackend, useSearchIndex, watcherIgnoredPath, workspaceIgnoreGlobs } from "../../src/filesystem/search-policy"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )

  it.live("prunes configured ignored trees during the initial candidate scan", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "ignored", "nested"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "ignored", "nested", "private.ts"), "secret\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "visible.ts"), "visible\n"))
        const result = yield* (yield* Ripgrep.Service).find({
          cwd,
          pattern: "*",
          limit: 10,
          ignore: ["ignored/**"],
        })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/visible.ts")])
      }),
    ),
  )
})

describe("FileSystemSearch backend ownership", () => {
  test("uses ripgrep when FFF cannot honor configured watcher ignores", () => {
    expect(searchBackend({ disableFff: false, available: true, watcherIgnore: ["generated/**"] })).toBe("ripgrep")
    expect(searchBackend({ disableFff: true, available: true, watcherIgnore: [] })).toBe("ripgrep")
    expect(searchBackend({ disableFff: false, available: false, watcherIgnore: [] })).toBe("ripgrep")
    expect(searchBackend({ disableFff: false, available: true, watcherIgnore: [] })).toBe("fff")
  })

  test("matches configured ignores against normalized workspace-relative paths", () => {
    expect(watcherIgnoredPath("generated\\nested\\file.ts", ["generated/**"])).toBe(true)
    expect(watcherIgnoredPath("src/file.ts", ["generated/**"])).toBe(false)
    expect(workspaceIgnoreGlobs(["C:/work/repo/generated/**", "external/**"], "C:/work/repo")).toEqual([
      "generated/**",
      "external/**",
    ])
  })

  test("bypasses the default materialized index when it cannot apply workspace ignores", () => {
    expect(useSearchIndex({ enabled: true, watcherIgnore: [] })).toBe(true)
    expect(useSearchIndex({ enabled: true, watcherIgnore: ["generated/**"] })).toBe(false)
    expect(useSearchIndex({ enabled: false, watcherIgnore: [] })).toBe(false)
  })
})
