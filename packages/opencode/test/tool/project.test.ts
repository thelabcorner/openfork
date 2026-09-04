import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import type { Tool } from "../../src/tool/tool"
import { ProjectTool } from "../../src/tool/project"
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

const it = testEffect(
  LayerNode.compile(LayerNode.group([filesystem, FSUtil.node, CrossSpawnSpawner.node, ToolRegistry.node])),
)

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

const write = (dir: string, name: string, content: string) =>
  Effect.promise(() => Bun.write(path.join(dir, name), content))

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

const run = Effect.fn("ProjectToolTest.run")(function* (
  args: Tool.InferParameters<typeof ProjectTool>,
  ctx: Tool.Context = asks().ctx,
) {
  const registry = yield* ToolRegistry.Service
  const tool = yield* toolByID(registry, ProjectTool.id)
  if (!tool) throw new Error("project tool not found")
  return yield* tool.execute(args, ctx)
})

// A small but representative repo: node stack with scripts, src/, tests/, a
// config, a gitignored subtree, and a sentinel source body that must never
// appear in output (hard rail: no source-body reads).
const initNodeRepo = (dir: string) =>
  Effect.gen(function* () {
    yield* write(
      dir,
      "package.json",
      JSON.stringify({
        name: "fixture-app",
        version: "1.2.3",
        packageManager: "bun@1.3.14",
        engines: { node: ">=20" },
        workspaces: ["packages/*"],
        dependencies: { react: "^18", "react-dom": "^18", next: "^14" },
        devDependencies: { typescript: "^5", vitest: "^1", eslint: "^8" },
        scripts: {
          dev: "bun run src/dev.ts",
          build: "bun run build.ts",
          test: "bun test",
          "test:e2e": "playwright test",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          format: "prettier --write .",
          "db:migrate": "bun run migrations.ts",
          release: "bun run release.ts",
          postinstall: "bun install",
        },
      }),
    )
    yield* write(dir, "bun.lockb", "\0\0\0")
    yield* write(dir, "tsconfig.json", '{"compilerOptions":{"strict":true}}')
    yield* write(dir, ".gitignore", "node_modules/\nbuild/\n*.log")
    yield* write(dir, ".env", "SECRET=never-should-print")
    yield* write(dir, ".github/workflows/ci.yml", "name: ci\non: [push]\n")
    yield* write(
      dir,
      "src/main.ts",
      "const SENTINEL_MAIN_BODY = 'project-tool-must-never-print-this'\nexport const main = () => 1\n",
    )
    yield* write(dir, "src/lib/util.ts", "export const util = () => 2\n")
    yield* write(dir, "src/components/Button.tsx", "export const Button = () => <button/>\n")
    yield* write(
      dir,
      "tests/app.test.ts",
      "import { expect, test } from 'vitest'\ntest('x', () => expect(1).toBe(1))\n",
    )
    yield* write(dir, "node_modules/dep/index.js", "module.exports = 1\n")
    yield* write(dir, "build/out.js", "console.log(1)\n")
    yield* write(dir, "README.md", "# fixture-app\n")
    yield* write(dir, "packages/shared/src/index.ts", "export const shared = () => 3\n")
  })

describe("tool.project", () => {
  it.instance(
    "summary tier: stack, scripts, entry, ci, stats; never reads source bodies",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const { items, ctx } = asks()
        const result = yield* run({ tier: "summary" }, ctx)

        // permission ask: one read ask scoped to the analyzed dir
        expect(items.map((i) => i.permission)).toEqual(["read"])
        expect(items[0]!.patterns).toEqual(["."])

        // stack
        expect(result.output).toContain('ecosystem="node"')
        expect(result.output).toContain('monorepo="true"')
        expect(result.output).toContain('packageManager="bun@1.3.14"')
        expect(result.output).toContain('lockfile="bun"')
        expect(result.output).toContain('<framework name="React" />')
        expect(result.output).toContain('<framework name="Next.js" />')
        expect(result.output).toContain('<framework name="ESLint" />')
        // entry points
        expect(result.output).toContain("<entry>")
        expect(result.output).toContain("src/main.ts")
        // CI presence (github workflows counted)
        expect(result.output).toContain('github=".github/workflows (1 workflows)"')
        // scripts summary: one per category, dev/build/test/lint/typecheck all present
        expect(result.output).toContain("dev → bun run src/dev.ts")
        expect(result.output).toContain("build → bun run build.ts")
        expect(result.output).toContain("test → bun test")
        expect(result.output).toContain("lint → eslint .")
        expect(result.output).toContain("typecheck → tsc --noEmit")
        // stats one-liner
        expect(result.output).toContain("<stats files=")
        expect(result.metadata.tier).toBe("summary")
        expect(result.metadata.files).toBeGreaterThan(0)
        // summary tier target: lean
        expect(result.output.split("\n").length).toBeLessThanOrEqual(40)
      }),
    { git: true },
  )

  it.instance(
    "summary action aliases the default snapshot tier",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ action: "summary", tier: "full" })

        expect(result.metadata.tier).toBe("summary")
        expect(result.output).toContain('ecosystem="node"')
        expect(result.output).not.toContain("<tree ")
      }),
    { git: true },
  )

  it.instance(
    "structure tier: gitignore-aware bounded tree with sizes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ tier: "structure", maxEntries: 500 })
        expect(result.output).toContain("<tree ")
        expect(result.output).toContain("src/ (")
        expect(result.output).toContain("components/ (")
        expect(result.output).toContain("Button.tsx")
        expect(result.output).toContain("tests/ (")
        // gitignore-aware: node_modules/ and build/ never appear
        expect(result.output).not.toContain("node_modules")
        expect(result.output).not.toContain("build/out.js")
        expect(result.output).not.toContain("dep/index.js")
        // sizes rendered humanized (e.g. "30 B", "38 B", "KB")
        expect(result.output).toMatch(/(\d+ B|KB|MB)/)
        // no body sentinel
        expect(result.output).not.toContain("SENTINEL_MAIN_BODY")
      }),
    { git: true },
  )

  it.instance(
    "full tier: annotated scripts + entry/config/CI lists + detailed stats",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ tier: "full" })
        // annotated scripts with categories
        expect(result.output).toContain('<scripts total="')
        expect(result.output).toContain('category="dev"')
        expect(result.output).toContain('category="test"')
        expect(result.output).toContain('category="lifecycle"')
        expect(result.output).toContain('name="db:migrate"')
        // config list
        expect(result.output).toContain("<config>")
        expect(result.output).toContain('kind="tsconfig"')
        expect(result.output).toContain('kind="env"')
        // ci list
        expect(result.output).toContain("<ci>")
        expect(result.output).toContain('kind="github"')
        // stats detail: per-type buckets
        expect(result.output).toContain("<type ext=")
        expect(result.output).toContain('ext=".ts"')
      }),
    { git: true },
  )

  it.instance(
    "summary tier caps script summary to one per category",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ tier: "summary" })
        // 'test:e2e' shares the 'test' category; only the first test script shown
        expect(result.output).not.toContain("test:e2e")
        expect(result.output).not.toContain("db:migrate") // db category not in top-5 summary
      }),
    { git: true },
  )

  it.instance(
    "tree respects maxEntries cap with 'N more files' hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        // add a pile of files to overflow a tiny cap
        for (let i = 0; i < 40; i++) {
          yield* write(test.directory, `src/generated/gen${i}.ts`, `export const g${i} = ${i}\n`)
        }
        const result = yield* run({ tier: "structure", maxEntries: 5 })
        expect(result.output).toContain("more files")
        expect(result.metadata.truncated).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "path param scopes to a subdirectory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const { items, ctx } = asks()
        const result = yield* run({ tier: "summary", path: "src" }, ctx)
        expect(items[0]!.patterns).toEqual(["src"])
        expect(result.metadata.path).toBe("src")
        // stack is detected by walking up from the scope to the worktree root
        expect(result.output).toContain('ecosystem="node"')
        expect(result.output).toContain('lockfile="bun"')
        // the file list is scope-relative, so the entry is main.ts
        expect(result.output).toContain("main.ts")
        // tree/stats are scoped to src/ (3 files)
        const stats = /<stats files="(\d+)"/.exec(result.output)
        expect(stats?.[1]).toBe("3")
      }),
    { git: true },
  )

  it.instance("empty repo: ecosystem unknown + hint, no error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "README.md", "# empty\n")
      const result = yield* run({ tier: "summary" })
      expect(result.output).toContain('ecosystem="unknown"')
      expect(result.output).toContain("no manifest detected")
      expect(result.output).toContain("<stats files=")
    }),
  )

  it.instance(
    "no-source-body-read rail: sentinel string never appears in any tier",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        for (const tier of ["summary", "structure", "full"] as const) {
          const result = yield* run({ tier })
          expect(result.output).not.toContain("SENTINEL_MAIN_BODY")
          expect(result.output).not.toContain("never-should-print")
        }
      }),
    { git: true },
  )

  it.instance("python stack detection (pyproject + requirements)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(
        test.directory,
        "pyproject.toml",
        [
          "[project]",
          'name = "pyapp"',
          'requires-python = ">=3.11"',
          "dependencies = [",
          '  "fastapi",',
          '  "pydantic>=2",',
          '  "pytest",',
          "]",
          "",
          "[tool.ruff]",
          "",
        ].join("\n"),
      )
      yield* write(test.directory, "requirements.txt", "# deps\nuvicorn\n")
      yield* write(test.directory, ".python-version", "3.12\n")
      yield* write(test.directory, "src/main.py", "print('x')\n")
      yield* write(test.directory, "app.py", "print('y')\n")
      const result = yield* run({ tier: "summary" })
      expect(result.output).toContain('ecosystem="python"')
      expect(result.output).toContain('<framework name="FastAPI" />')
      expect(result.output).toContain('<framework name="pytest" />')
      expect(result.output).toContain('kind=".python-version"')
      expect(result.output).toContain("src/main.py")
    }),
  )

  it.instance("rust + go + java + ruby + php stack detection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sub = (name: string) => path.join(test.directory, name)
      // each ecosystem in its own subdir so detection priority is unambiguous
      yield* write(
        sub("rust"),
        "Cargo.toml",
        '[package]\nname = "r" \nedition = "2021"\n\n[dependencies]\ntokio = "1"\nserde = "1"\naxum = "0.7"\n',
      )
      yield* write(sub("rust"), "Cargo.lock", "# lock\n")
      yield* write(sub("rust"), "src/main.rs", "fn main() {}\n")
      let result = yield* run({ tier: "summary", path: "rust" })
      expect(result.output).toContain('ecosystem="rust"')
      expect(result.output).toContain('<framework name="tokio" />')
      expect(result.output).toContain('lockfile="cargo"')

      yield* write(
        sub("go"),
        "go.mod",
        "module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n",
      )
      yield* write(sub("go"), "go.sum", "sum\n")
      yield* write(sub("go"), "main.go", "package main\nfunc main() {}\n")
      yield* write(sub("go"), "cmd/serve/main.go", "package main\nfunc main() {}\n")
      result = yield* run({ tier: "summary", path: "go" })
      expect(result.output).toContain('ecosystem="go"')
      expect(result.output).toContain('lockfile="go"')
      expect(result.output).toContain("main.go")
      expect(result.output).toContain("cmd/serve/main.go")

      yield* write(
        sub("java"),
        "pom.xml",
        "<project><groupId>com.x</groupId><artifactId>app</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
      )
      result = yield* run({ tier: "summary", path: "java" })
      expect(result.output).toContain('ecosystem="java"')
      expect(result.output).toContain('<framework name="Spring Boot" />')

      yield* write(sub("ruby"), "Gemfile", 'source "https://rubygems.org"\ngem "rails", "~> 7.0"\ngem "rspec"\n')
      yield* write(sub("ruby"), "Gemfile.lock", "lock\n")
      result = yield* run({ tier: "summary", path: "ruby" })
      expect(result.output).toContain('ecosystem="ruby"')
      expect(result.output).toContain('<framework name="Rails" />')
      expect(result.output).toContain('lockfile="bundler"')

      yield* write(
        sub("php"),
        "composer.json",
        JSON.stringify({ require: { "laravel/framework": "^10", "symfony/console": "^6" } }),
      )
      yield* write(sub("php"), "composer.lock", "{}")
      result = yield* run({ tier: "summary", path: "php" })
      expect(result.output).toContain('ecosystem="php"')
      expect(result.output).toContain('<framework name="Laravel" />')
      expect(result.output).toContain('lockfile="composer"')
    }),
  )

  it.instance("manifest too large is skipped with a note, not read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "package.json", "x".repeat(300_000))
      const result = yield* run({ tier: "summary" })
      expect(result.output).toContain("package.json skipped: too large")
      expect(result.output).toContain('ecosystem="unknown"')
    }),
  )

  it.instance(
    "summary includes git + init blocks (worktree, branch, changed)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        // mark one file modified so git status is non-empty
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "README.md"), "# changed\n"))
        const result = yield* run({ tier: "summary" })
        expect(result.output).toContain("<git ")
        expect(result.output).toContain('branch="')
        expect(result.output).toContain("changed=")
        expect(result.output).toContain("<init ")
        expect(result.output).toContain('manifest="true"')
        expect(result.output).toContain('git="true"')
        expect(result.output).toContain('lockfile="true"')
        expect(result.output).toContain('<script name="dev"')
        expect(result.output).toContain('<script name="test"')
      }),
    { git: true },
  )

  it.instance("non-git repo: git section skipped gracefully", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "package.json", JSON.stringify({ name: "x", scripts: { test: "bun test" } }))
      const result = yield* run({ tier: "summary" })
      expect(result.output).not.toContain("<git ")
      expect(result.output).toContain("<init ")
      expect(result.output).toContain('git="false"')
    }),
  )

  it.instance(
    "recent action: newest files first, grouped by dir, relative times",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        // touch files with distinct mtimes: main.ts newest, util.ts old, rest older
        yield* Effect.promise(async () => {
          const day = new Date(Date.now() - 86_400_000)
          const hour = new Date(Date.now() - 3_600_000)
          const minute = new Date(Date.now() - 60_000)
          for (const rel of [
            "README.md",
            "tsconfig.json",
            "bun.lockb",
            "tests/app.test.ts",
            "src/components/Button.tsx",
            "packages/shared/src/index.ts",
            ".env",
            ".github/workflows/ci.yml",
          ]) {
            await fs.utimes(path.join(test.directory, rel), day, day)
          }
          await fs.utimes(path.join(test.directory, "src/lib/util.ts"), hour, hour)
          await fs.utimes(path.join(test.directory, "src/main.ts"), minute, minute)
        })
        const result = yield* run({ action: "recent", recent: 5 })
        expect(result.output).toContain("<recent ")
        expect(result.output).toContain("src/main.ts")
        expect(result.output).toContain('modified="1m ago"')
        expect(result.output).toContain('modified="1h ago"')
        expect(result.metadata.recent).toBeGreaterThan(0)
        // newest first: main.ts appears before util.ts
        const mainIdx = result.output.indexOf("src/main.ts")
        const utilIdx = result.output.indexOf("src/lib/util.ts")
        expect(mainIdx).toBeGreaterThan(-1)
        expect(mainIdx).toBeLessThan(utilIdx)
      }),
    { git: true },
  )

  it.instance(
    "recent action caps at recent param and respects gitignore",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ action: "recent", recent: 2 })
        expect(result.output).toContain('count="2"')
        expect(result.output).not.toContain("node_modules")
        expect(result.output).not.toContain("build/out.js")
      }),
    { git: true },
  )

  it.instance(
    "toolchain action: reports installed runtimes + env",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* initNodeRepo(test.directory)
        const result = yield* run({ action: "toolchain" })
        expect(result.output).toContain("<toolchain ")
        expect(result.output).toContain('<runtime name="bun"')
        expect(result.output).toContain('<runtime name="node"')
        // env block present
        expect(result.output).toContain('<env name="PATH"')
      }),
    { git: true },
  )

  it.instance("path outside worktree is rejected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = path.join(test.directory, "..", "..", "..", "outside")
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "x"))
      const exit = yield* run({ tier: "summary", path: outside }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("registry exposes the project tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      })
      const tool = tools.find((t) => t.id === ProjectTool.id)
      expect(tool).toBeDefined()
      if (tool) {
        expect(tool.description).toContain("orientation")
      }
    }),
  )
})
