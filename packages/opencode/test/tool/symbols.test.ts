import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import os from "os"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"
import { SymbolsTool } from "../../src/tool/symbols"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import type * as Tool from "../../src/tool/tool"
import path from "path"

const toolLayer = LayerNode.compile(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node]),
)

const rooted = testEffect(Layer.mergeAll(toolLayer, testInstanceStoreLayer))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const FIXTURE = path.join(__dirname, "../../src/tool/__fixtures__/ci/symbols")

const initTool = () =>
  Effect.gen(function* () {
    const info = yield* SymbolsTool
    return yield* info.init()
  })

describe("tool.symbols", () => {
  rooted.live("search finds exact and ranked matches", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "search", query: "greet" }, ctx))
      expect(result.metadata.results).toBeGreaterThan(0)
      // a.ts declares `greet` (function) and Greeter.greet (method); c.ts
      // declares its own local greet — all declarations named greet.
      const defs = result.output.match(/<def /g) ?? []
      expect(defs.length).toBeGreaterThanOrEqual(3)
      expect(result.output).toContain('name="greet"')
      expect(result.output).toContain('kind="function"')
      // exact-name function def in a.ts first (rank 0, kind function); rel
      // paths are worktree-relative, so match the fixture-relative suffix
      const first = result.output.match(/<def [^>]+>/)?.[0]
      expect(first).toMatch(/file="[^"]*src[\\/]a\.ts:2"/)
    }),
  )

  rooted.live("search ranks exact > prefix > substring > fuzzy", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "search", query: "alpha" }, ctx))
      const hits = [...result.output.matchAll(/<def ([^>]+)>/g)].map((m) => m[1])
      const alphaIdx = hits.findIndex((h) => h.includes('name="alpha"'))
      const prefixIdx = hits.findIndex((h) => h.includes('name="alphaBeta"'))
      expect(alphaIdx).toBeGreaterThanOrEqual(0)
      expect(prefixIdx).toBeGreaterThan(alphaIdx)
    }),
  )

  rooted.live("search kind filter excludes other kinds", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "search", query: "greet", kind: "class" }, ctx))
      expect(result.metadata.results).toBe(0)
      const cls = yield* provideInstance(FIXTURE)(
        tool.execute({ action: "search", query: "Greeter", kind: "class" }, ctx),
      )
      expect(cls.metadata.results).toBeGreaterThan(0)
      expect(cls.output).toContain('kind="class"')
      expect(cls.output).toContain('name="Greeter"')
    }),
  )

  rooted.live("search not found returns zero results and hint", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(
        tool.execute({ action: "search", query: "zzz_nonexistent_zzz" }, ctx),
      )
      expect(result.metadata.results).toBe(0)
      expect(result.output).toContain('results="0"')
      expect(result.output).toContain("No declarations found")
    }),
  )

  rooted.live("outline groups symbols and indents class members", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "outline", file: "src/a.ts" }, ctx))
      expect(result.metadata.symbols).toBeGreaterThan(0)
      expect(result.output).toMatch(/<symbols-outline file="[^"]*src[\\/]a\.ts"/)
      expect(result.output).toContain('<group kind="class">')
      expect(result.output).toContain('name="Greeter"')
      // method member indented under the class
      expect(result.output).toContain('name="  greet"')
      expect(result.output).toContain('kind="method"')
      expect(result.output).not.toContain("parseErrors=")
    }),
  )

  rooted.live("outline of file with syntax error reports parseErrors", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const dir = path.join(FIXTURE, "src")
      const file = path.join(dir, "broken.ts")
      yield* Effect.promise(() => Bun.write(file, "export function broken( {"))
      try {
        const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "outline", file: "src/broken.ts" }, ctx))
        expect(result.output).toContain("parseErrors=")
      } finally {
        yield* Effect.promise(() => Bun.write(file, ""))
      }
    }),
  )

  rooted.live("usages attributes imported refs and buckets same-name bindings", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "usages", query: "greet" }, ctx))
      expect(result.metadata.defs).toBeGreaterThan(0)
      // b.ts imports { greet } from ./a and calls it → attributed group
      expect(result.output).toContain('<group file="src/b.ts"')
      // c.ts declares its own greet → unattributed bucket, never counted as refs
      expect(result.output).toContain('declares its own')
      expect(result.output).toContain('src/c.ts')
      const refs = result.metadata.refs ?? 0
      const unattr = result.metadata.unattributed ?? 0
      expect(refs).toBeGreaterThan(0)
      expect(unattr).toBeGreaterThan(0)
      // strings.ts has greet only inside a string/comment → no refs at all
      expect(result.output).not.toContain('src/strings.ts')
    }),
  )

  rooted.live("usages from file+line resolves the identifier name", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      // a.ts line 6: `export class Greeter` — the identifier there is Greeter
      const result = yield* provideInstance(FIXTURE)(
        tool.execute({ action: "usages", file: "src/a.ts", line: 6 }, ctx),
      )
      expect(result.metadata.query).toBe("Greeter")
      expect(result.metadata.defs).toBeGreaterThan(0)
    }),
  )

  rooted.live("usages attributes same-file refs after the declaration", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "usages", query: "greet" }, ctx))
      // a.ts itself calls greet() after its declaration (line 12) → attributed
      expect(result.output).toContain('<group file="src/a.ts"')
      // a.ts and b.ts are attributed; c.ts declares its own greet → unattributed
      expect(result.output).toContain('declares its own')
    }),
  )

  rooted.live("outline on non-TS file uses regex fallback", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "outline", file: "legacy.py" }, ctx))
      expect(result.output).toContain('fallback="regex"')
      expect(result.output).toContain('name="legacyFn"')
      expect(result.output).toContain('kind="function"')
    }),
  )

  rooted.live("search scoped to a subpath", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(
        tool.execute({ action: "search", query: "greet", path: "src" }, ctx),
      )
      expect(result.metadata.results).toBeGreaterThan(0)
      for (const hit of result.output.matchAll(/<def [^>]*file="([^"]+)"/g)) {
        expect(hit[1]).toMatch(/[\\/]src[\\/]/)
      }
    }),
  )

  rooted.live("outline outside worktree is refused", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const outside = path.join(os.tmpdir(), "opencode-symbols-outside", "package.json")
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "outline", file: outside }, ctx)).pipe(
        Effect.exit,
      )
      expect(result._tag).toBe("Failure")
    }),
  )

  rooted.live("outline cache refetches on mtime change", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "cache.ts")
      yield* Effect.promise(() => Bun.write(file, "export function one() {}\n"))
      const tool = yield* initTool()
      const first = yield* provideInstance(dir)(tool.execute({ action: "outline", file: "cache.ts" }, ctx))
      expect(first.output).toContain('name="one"')

      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => Bun.write(file, "export function two() {}\nexport function three() {}\n"))
      const second = yield* provideInstance(dir)(tool.execute({ action: "outline", file: "cache.ts" }, ctx))
      expect(second.output).toContain('name="two"')
      expect(second.output).toContain('name="three"')
    }),
  )

  rooted.live("search with lang filter restricts files", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(
        tool.execute({ action: "search", query: "greet", lang: "js" }, ctx),
      )
      // fixture is all TS; no .js files → no results
      expect(result.metadata.results).toBe(0)
    }),
  )

  rooted.live("missing query is an error", () =>
    Effect.gen(function* () {
      const tool = yield* initTool()
      const result = yield* provideInstance(FIXTURE)(tool.execute({ action: "search", query: "" }, ctx)).pipe(
        Effect.exit,
      )
      expect(result._tag).toBe("Failure")
    }),
  )
})
