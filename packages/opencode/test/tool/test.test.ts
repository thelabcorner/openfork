import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { TestTool } from "../../src/tool/test"
import { TestScope } from "../../src/tool/test-scope"
import { ToolRegistry } from "@/tool/registry"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
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
  LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])),
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

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

const write = (dir: string, name: string, content: string) => Effect.promise(() => Bun.write(path.join(dir, name), content))

// ---------------------------------------------------------------------------
// Harness detection (pure, fixture dirs — no spawn)
// ---------------------------------------------------------------------------

const pkg = (scripts: Record<string, string>, deps: Record<string, string> = {}) =>
  JSON.stringify({ scripts, devDependencies: deps, dependencies: {} }, null, 2)

describe("test-scope detection", () => {
  test("detects bun from the test script", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), pkg({ test: "bun test" }))
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("bun")
    expect(detected?.via).toContain("bun test")
  })

  test("detects bun from bun.lock", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "bun.lock"), "")
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("bun")
  })

  test("detects node:test from the test script", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), pkg({ test: "node --test" }))
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("node")
  })

  test("detects node:test from test files importing node:test", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.test.mjs"), "import { test } from 'node:test'\n")
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("node")
  })

  test("detects vitest from config file", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "vitest.config.ts"), "export default {}\n")
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("vitest")
    expect(detected?.via).toContain("vitest.config.ts")
  })

  test("detects jest from a devDependency", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), pkg({ test: "jest" }, { jest: "^29.0.0" }))
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("jest")
  })

  test("vitest wins over jest by priority", async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "package.json"),
      pkg({ test: "jest" }, { vitest: "^1.0.0", jest: "^29.0.0" }),
    )
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("vitest")
  })

  test("detects mocha from a devDependency (best-effort)", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), pkg({ test: "mocha" }, { mocha: "^10.0.0" }))
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected?.harness).toBe("mocha")
  })

  test("returns undefined when a package.json has no harness signal", async () => {
    await using tmp = await tmpdir()
    // A signal-less package.json is the project boundary: detection must not
    // keep walking up into ancestor directories.
    await Bun.write(path.join(tmp.path, "package.json"), pkg({}))
    const detected = await TestScope.detectHarness(tmp.path, tmp.path)
    expect(detected).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Reporter parsing (pure, canned outputs — the real shapes captured from
// bun 1.3.14 / node 22.23.2 during design research)
// ---------------------------------------------------------------------------

const BUN_OUTPUT = `bun test v1.3.14 (0d9b296a)

add.test.ts:
(pass) add > adds [0.08ms]
(skip) add > skipped add
10 |   })
11 |   test.skip('skipped add', () => {
12 |     expect(add(1, 2)).toBe(4)
13 |   })
14 |   test('fails', () => {
15 |     expect(add(1, 1)).toBe(3)
                           ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (C:\\tmp\\add.test.ts:15:23)
(fail) add > fails [0.26ms]

 1 pass
 1 skip
 1 fail
 2 expect() calls
Ran 3 tests across 1 file. [66.00ms]
`

const NODE_TAP_OUTPUT = `TAP version 13
# Subtest: add
    # Subtest: adds
    ok 1 - adds
      ---
      duration_ms: 0.6648
      type: 'test'
      ...
    # Subtest: skipped add
    ok 2 - skipped add # SKIP
      ---
      duration_ms: 0.1425
      type: 'test'
      ...
    # Subtest: fails
    not ok 3 - fails
      ---
      duration_ms: 0.6273
      type: 'test'
      location: 'C:\\tmp\\add.test.mjs:15:3'
      failureType: 'testCodeFailure'
      error: '2 == 3'
      code: 'ERR_ASSERTION'
      ...
    1..3
not ok 1 - add
  ---
  duration_ms: 2.5376
  type: 'suite'
  failureType: 'subtestsFailed'
  ...
1..1
# tests 3
# suites 1
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 105.3844
`

const JEST_JSON_OUTPUT = JSON.stringify({
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  numTodoTests: 0,
  success: false,
  testResults: [
    {
      name: "C:\\tmp\\add.test.js",
      status: "failed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["add"],
          fullName: "add adds",
          status: "passed",
          title: "adds",
          duration: 4,
          failureMessages: [],
        },
        {
          ancestorTitles: ["add"],
          fullName: "add skips",
          status: "pending",
          title: "skips",
          duration: 0,
          failureMessages: [],
        },
        {
          ancestorTitles: ["add"],
          fullName: "add fails",
          status: "failed",
          title: "fails",
          duration: 5,
          failureMessages: [
            "expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n\n    at Object.<anonymous> (C:/tmp/add.test.js:14:3)",
          ],
        },
      ],
    },
  ],
})

describe("test-scope reporter parsing", () => {
  test("parses bun text output", () => {
    const summary = TestScope.parseReporter(BUN_OUTPUT, "bun", 1)
    expect(summary.parsed).toBe(true)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.failures).toHaveLength(1)
    const failure = summary.failures[0]
    expect(failure.fullName).toBe("add > fails")
    expect(failure.assertion).toContain("Expected: 3")
    expect(failure.line).toBe(15)
    expect(failure.file).toContain("add.test.ts")
  })

  test("parses node:test TAP13 and does not double-count suite failures", () => {
    const summary = TestScope.parseReporter(NODE_TAP_OUTPUT, "node", 1)
    expect(summary.parsed).toBe(true)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(1)
    // The suite entry (not ok 1 - add, type suite) must not appear as a failure.
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0].fullName).toBe("add > fails")
    expect(summary.failures[0].line).toBe(15)
    expect(summary.failures[0].assertion).toBe("2 == 3")
    expect(summary.durationMs).toBeCloseTo(105.3844, 3)
  })

  test("parses jest-compatible JSON", () => {
    const summary = TestScope.parseReporter(JEST_JSON_OUTPUT, "jest", 1)
    expect(summary.parsed).toBe(true)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.failures[0].fullName).toBe("add fails")
    expect(summary.failures[0].assertion).toBe("expect(received).toBe(expected)")
    expect(summary.failures[0].file).toContain("add.test.js")
    expect(summary.failures[0].line).toBe(14)
  })

  test("falls back to generic text with parsed=false", () => {
    const summary = TestScope.parseReporter("some unparseable output\nno structure here", "bun", 3)
    expect(summary.parsed).toBe(false)
    expect(summary.failed).toBe(0)
    expect(summary.exitCode).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Command construction (pure-ish, no spawn)
// ---------------------------------------------------------------------------

describe("test-scope command construction", () => {
  test("bun maps path + testNamePattern to -t", async () => {
    const cmd = await TestScope.buildCommand({
      harness: "bun",
      dir: "C:\\repo",
      path: "src/foo.test.ts",
      filter: "add",
    })
    expect(cmd.bin).toBe("bun")
    expect(cmd.args).toEqual(["test", "src/foo.test.ts", "-t", "add"])
  })

  test("node maps filter to --test-name-pattern and taps the reporter", async () => {
    const cmd = await TestScope.buildCommand({
      harness: "node",
      dir: "C:\\repo",
      path: "src/foo.test.mjs",
      filter: "add",
    })
    expect(cmd.bin).toBe("node")
    expect(cmd.args).toEqual(["--test", "src/foo.test.mjs", "--test-name-pattern=add", "--test-reporter=tap"])
  })

  test("ava translates filter to --match=*name* (via local bin)", async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "node_modules", "ava", "package.json"),
      JSON.stringify({ bin: { ava: "./entrypoints/cli.mjs" } }),
    )
    await Bun.write(path.join(tmp.path, "node_modules", "ava", "entrypoints", "cli.mjs"), "export {}\n")
    const cmd = await TestScope.buildCommand({ harness: "ava", dir: tmp.path, filter: "add" })
    expect(cmd.args).toContain("--match=*add*")
    expect(cmd.bin).toBe("node")
  })

  test("rejects bun harness with runtime=node", async () => {
    const result = await TestScope.buildCommand({ harness: "bun", dir: "C:\\repo", runtime: "node" })
      .then(() => "ok")
      .catch((e: Error) => e.message)
    expect(result).toContain("runtime=node")
  })

  test("errors when a node-based harness has no local bin", async () => {
    const result = await TestScope.buildCommand({ harness: "vitest", dir: "C:\\nope", filter: "add" })
      .then(() => "ok")
      .catch((e: Error) => e.message)
    expect(result).toContain('not installed locally')
  })
})

// ---------------------------------------------------------------------------
// Tool-level tests (live spawns on tiny fixture repos in the temp dir)
// ---------------------------------------------------------------------------

const bunFixture = (dir: string) =>
  Effect.gen(function* () {
    yield* write(dir, "package.json", pkg({ test: "bun test" }))
    yield* write(
      dir,
      "add.test.ts",
      [
        `import { test, expect, describe } from "bun:test"`,
        ``,
        `function add(a: number, b: number) {`,
        `  return a + b`,
        `}`,
        ``,
        `describe("add", () => {`,
        `  test("adds", () => {`,
        `    expect(add(1, 2)).toBe(3)`,
        `  })`,
        `  test.skip("skipped add", () => {`,
        `    expect(add(1, 2)).toBe(4)`,
        `  })`,
        `  test("fails", () => {`,
        `    expect(add(1, 1)).toBe(3)`,
        `  })`,
        `})`,
      ].join("\n"),
    )
  })

const nodeFixture = (dir: string) =>
  Effect.gen(function* () {
    yield* write(dir, "package.json", pkg({ test: "node --test" }))
    yield* write(
      dir,
      "add.test.mjs",
      [
        `import { test, describe } from "node:test"`,
        `import assert from "node:assert"`,
        ``,
        `function add(a, b) {`,
        `  return a + b`,
        `}`,
        ``,
        `describe("add", () => {`,
        `  test("adds", () => {`,
        `    assert.equal(add(1, 2), 3)`,
        `  })`,
        `  test("skipped add", { skip: true }, () => {`,
        `    assert.equal(add(1, 2), 4)`,
        `  })`,
        `  test("fails", () => {`,
        `    assert.equal(add(1, 1), 3)`,
        `  })`,
        `})`,
      ].join("\n"),
    )
  })

describe("tool.test", () => {
  it.instance("asks the dedicated 'test' permission with the resolved command as pattern", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* bunFixture(test.directory)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const { items, ctx } = asks()
      yield* tool.execute({ path: "add.test.ts" }, ctx)
      const ask = items.find((i) => i.permission === "test")
      expect(ask).toBeDefined()
      expect(ask!.patterns[0]).toContain("bun test")
      expect(ask!.patterns[0]).toContain("add.test.ts")
      expect(ask!.always).toEqual(ask!.patterns)
    }),
  )

  it.instance("runs a bun fixture and reports the parsed summary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* bunFixture(test.directory)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const result = yield* tool.execute({}, asks().ctx)
      expect(result.output).toContain('harness="bun"')
      expect(result.output).toContain('status="failed"')
      expect(result.output).toContain("<summary>1 passed / 1 failed / 1 skipped")
      expect(result.output).toContain('name="add &gt; fails"')
      expect(result.output).toContain('<fullOutput path="')
      expect(result.metadata.passed).toBe(1)
      expect(result.metadata.failed).toBe(1)
      expect(result.metadata.skipped).toBe(1)
    }),
  )

  it.instance("runs a node:test fixture and parses TAP", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* nodeFixture(test.directory)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const result = yield* tool.execute({ path: "add.test.mjs" }, asks().ctx)
      expect(result.output).toContain('harness="node"')
      expect(result.output).toContain("<summary>1 passed / 1 failed / 1 skipped")
      expect(result.output).toContain('name="add &gt; fails"')
      expect(result.output).toContain('detail="2 == 3"')
      expect(result.output).toContain('line="15"')
      expect(result.metadata.failed).toBe(1)
    }),
  )

  it.instance("passing tests report status=passed and stay lean", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* bunFixture(test.directory)
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const result = yield* tool.execute({ testNamePattern: "adds" }, asks().ctx)
      expect(result.output).toContain('status="passed"')
      expect(result.output).toContain("<summary>1 passed / 0 failed / 0 skipped")
      expect(result.output).not.toContain("<failures")
    }),
  )

  it.instance("kills the child on timeout and reports timed-out", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* bunFixture(test.directory)
      yield* write(test.directory, "slow.test.ts", 'import { test } from "bun:test"\ntest("slow", async () => { await Bun.sleep(5000) })\n')
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const result = yield* tool.execute({ timeoutMs: 500 }, asks().ctx)
      expect(result.output).toContain('status="timed-out"')
      expect(result.output).toContain('partial="true"')
      expect(result.metadata.status).toBe("timed-out")
    }),
  )

  it.instance("list enumerates test files without executing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* bunFixture(test.directory)
      yield* write(test.directory, "other.test.ts", 'import { test } from "bun:test"\ntest("x", () => {})\n')
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const result = yield* tool.execute({ action: "list" }, asks().ctx)
      expect(result.output).toContain('<test-list harness="bun"')
      expect(result.output).toContain('files="2"')
      expect(result.output).toContain('path="add.test.ts"')
      expect(result.output).toContain('path="other.test.ts"')
      expect(result.output).toContain("names=\"?\"")
    }),
  )

  it.instance("no harness detected is a clear error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Signal-less package.json pins the project boundary so detection cannot
      // walk up into ancestor directories.
      yield* write(test.directory, "package.json", pkg({}))
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, TestTool.id)
      if (!tool) throw new Error("test tool not found")
      const exit = yield* tool.execute({}, asks().ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const message = exit._tag === "Failure" ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("No test harness detected")
    }),
  )
})
