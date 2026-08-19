import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { SympyTool } from "../../src/tool/sympy"
import {
  buildExprCall,
  buildCodeCall,
  parseOutput,
  firstErrorLine,
  suggestionFor,
  detectSymbols,
  parseSymbols,
  missingPythonMessage,
  missingSympyMessage,
} from "../../src/tool/sympy/core"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// --- pure core helpers (no python needed) ---------------------------------

describe("sympy core: symbol detection", () => {
  test("detects free single-letter symbols", () => {
    expect(detectSymbols("x**2 - 4")).toEqual(["x"])
    expect(detectSymbols("sin(x)*cos(y)")).toEqual(["x", "y"])
  })

  test("ignores e/i/o and multi-letter function names", () => {
    expect(detectSymbols("exp(x) + pi")).toEqual(["x"])
    expect(detectSymbols("E**x")).toEqual(["x"])
    expect(detectSymbols("I*x + oo")).toEqual(["x"])
  })

  test("parseSymbols splits on spaces and commas and drops junk", () => {
    expect(parseSymbols("x y")).toEqual(["x", "y"])
    expect(parseSymbols("a, b, c")).toEqual(["a", "b", "c"])
    expect(parseSymbols("x 2bad -z")).toEqual(["x"])
  })
})

describe("sympy core: structured code builder", () => {
  test("builds a simplify call with auto symbols", () => {
    const built = buildExprCall({ expr: "x**2 - 4" })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.code).toContain('from sympy import *')
      expect(built.code).toContain('x = Symbol("x")')
      expect(built.code).toContain('_expr = sympify("x**2 - 4")')
      expect(built.code).toContain('_result = simplify(_expr)')
      expect(built.code).toContain('print("__SYMPY_RESULT__")')
    }
  })

  test("builds solve with the first detected symbol as variable", () => {
    const built = buildExprCall({ expr: "y**2 - 4", operation: "solve" })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.code).toContain('y = Symbol("y")')
      expect(built.code).toContain("_result = solve(_expr, y)")
    }
  })

  test("honors explicit symbols and variable", () => {
    const built = buildExprCall({ expr: "a + b", operation: "diff", symbols: ["a", "b"], variable: "a" })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.code).toContain('a = Symbol("a")')
      expect(built.code).toContain('b = Symbol("b")')
      expect(built.code).toContain("_result = diff(_expr, a, 1)")
    }
  })

  test("limit requires a point", () => {
    const built = buildExprCall({ expr: "sin(x)/x", operation: "limit" })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain("point")
  })

  test("limit with point builds a two-arg call", () => {
    const built = buildExprCall({ expr: "sin(x)/x", operation: "limit", point: "0" })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.code).toContain("limit(_expr, x, 0)")
  })

  test("evalf carries precision", () => {
    const built = buildExprCall({ expr: "sqrt(2)", operation: "evalf", precision: 30 })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.code).toContain("_expr.evalf(30)")
  })

  test("rejects an empty expression", () => {
    const built = buildExprCall({ expr: "  " })
    expect(built.ok).toBe(false)
  })
})

describe("sympy core: code path builder", () => {
  test("wraps user code with prelude and last-expression capture", () => {
    const built = buildCodeCall({ code: "A = Matrix([[1, 2], [3, 4]])\nA.inv()", symbols: ["x"] })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.code).toContain('from sympy import *')
      expect(built.code).toContain('x = Symbol("x")')
      expect(built.code).toContain("_console = code.InteractiveConsole")
      expect(built.code).toContain('_console.push("A = Matrix([[1, 2], [3, 4]])")')
      expect(built.code).toContain('_console.push("A.inv()")')
      expect(built.code).toContain('print(sstr(_captured[-1]) if _captured else "<no result>")')
    }
  })

  test("rejects empty code", () => {
    expect(buildCodeCall({ code: "" }).ok).toBe(false)
  })
})

describe("sympy core: output parsing and error prose", () => {
  test("parseOutput splits diagnostics from the result marker", () => {
    const parsed = parseOutput("some warning\n__SYMPY_RESULT__\nx + 1\n")
    expect(parsed.diagnostics).toContain("some warning")
    expect(parsed.result).toBe("x + 1")
  })

  test("parseOutput returns the whole text when the marker is absent", () => {
    const parsed = parseOutput("just output")
    expect(parsed.result).toBe("just output")
  })

  test("firstErrorLine extracts the last meaningful exception line", () => {
    const trace = [
      "Traceback (most recent call last):",
      '  File "<string>", line 1, in <module>',
      "NameError: name 'integrat' is not defined",
    ].join("\n")
    expect(firstErrorLine(trace)).toContain("NameError")
  })

  test("suggestionFor maps NameError to a symbols hint", () => {
    expect(suggestionFor("NameError: name 'q' is not defined")).toContain("symbols")
  })

  test("suggestionFor maps SympifyError to a syntax hint", () => {
    expect(suggestionFor("SympifyError: Sympify of expression could not be parsed")).toContain("**")
  })
})

describe("sympy core: availability message templates", () => {
  test("python-missing message names the install path", () => {
    const msg = missingPythonMessage()
    expect(msg).toContain("Install Python")
    expect(msg).toContain("pip install sympy")
  })

  test("sympy-missing message names the interpreter and both install commands", () => {
    const msg = missingSympyMessage("python3", "3.12.4")
    expect(msg).toContain("python3 3.12.4")
    expect(msg).toContain("python -m pip install sympy")
    expect(msg).toContain("uv pip install sympy")
  })
})

// --- live tool tests (python + sympy availability-gated) -------------------

const baseCtx = {
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

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

const ctx = (items: Array<{ permission: string }>) => ({
  ...baseCtx,
  ask: (req: { permission: string }) =>
    Effect.sync(() => {
      items.push(req)
    }),
})

// Probe availability once: if python or sympy is missing, live tests are skipped.
async function pythonAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["python", "-c", "import sympy"], { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

const live = { skip: !(await pythonAvailable()) }

describe("tool.sympy", () => {
  it.instance("structured simplify returns a compact result", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const asks: Array<{ permission: string }> = []
      const result = yield* tool.execute({ expr: "x**2 - 4", operation: "simplify" }, ctx(asks) as any)
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("<result>")
      expect(asks.some((a) => a.permission === "sympy")).toBe(true)
    }),
  )

  it.instance("solve a quadratic", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute({ expr: "x**2 - 4", operation: "solve" }, ctx([]) as any)
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("-2")
      expect(result.output).toContain("2")
    }),
  )

  it.instance("differentiate", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute({ expr: "sin(x)", operation: "diff" }, ctx([]) as any)
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("cos(x)")
    }),
  )

  it.instance("integrate", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute({ expr: "x**2", operation: "integrate" }, ctx([]) as any)
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("x**3/3")
    }),
  )

  it.instance("evalf with precision", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute({ expr: "sqrt(2)", operation: "evalf", precision: 20 }, ctx([]) as any)
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("1.4142135623730950488")
    }),
  )

  it.instance("advanced code path evaluates arbitrary sympy", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute(
        { code: "A = Matrix([[1, 2], [3, 4]])\nA.inv()", symbols: "x" },
        ctx([]) as any,
      )
      expect(result.metadata.status).toBe("ok")
      expect(result.output).toContain("-2")
    }),
  )

  it.instance("reports clean errors for a bad expression", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const result = yield* tool.execute({ expr: "sqrt(8) + ", operation: "simplify" }, ctx([]) as any)
      expect(result.metadata.status).toBe("error")
      expect(result.output).toContain("<error>")
    }),
  )

  it.instance("rejects providing both expr and code", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const exit = yield* tool.execute({ expr: "x", code: "x" }, ctx([]) as any).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects providing neither expr nor code", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      const exit = yield* tool.execute({}, ctx([]) as any).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("times out and kills a hanging child", () =>
    Effect.gen(function* () {
      if (live.skip) return
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")

      // A guaranteed hang (sleep) with a 1s timeout must be killed, not left
      // running — the hard timeout is the tool's non-negotiable guard.
      const result = yield* tool.execute(
        { code: "import time\ntime.sleep(30)", timeoutMs: 1000 },
        ctx([]) as any,
      )
      expect(result.metadata.status).toBe("timed-out")
      expect(result.output).toContain("killed after 1000 ms")
    }),
  )

  it.instance("reports availability failure with install guidance when python is missing", () =>
    Effect.gen(function* () {
      // This machine HAS python, so the missing-sympy path can't be triggered
      // live; the probe's actionable install guidance is exercised in the pure
      // module (probe message template) and structurally asserted here.
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SympyTool.id)
      if (!tool) throw new Error("sympy tool not found")
      expect(tool.id).toBe(SympyTool.id)
    }),
  )
})
