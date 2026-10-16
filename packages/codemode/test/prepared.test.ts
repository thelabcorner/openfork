import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"


describe("CodeMode prepared programs", () => {
  test("uses the JavaScript parser fast path and falls back to TypeScript only when needed", async () => {
    const javascript = CodeMode.prepare("const value = input.value + 1; return value")
    const typescript = CodeMode.prepare("const value: number = input.value + 1; return value")

    expect(javascript.syntax).toBe("javascript")
    expect(typescript.syntax).toBe("typescript")

    const jsResult = await Effect.runPromise(CodeMode.executePrepared(javascript, { input: { value: 4 } }))
    const tsResult = await Effect.runPromise(CodeMode.executePrepared(typescript, { input: { value: 4 } }))
    expect(jsResult).toMatchObject({ ok: true, value: 5 })
    expect(tsResult).toMatchObject({ ok: true, value: 5 })
  })

  test("reuses one parsed program across fresh executions without carrying authority or state", async () => {
    const prepared = CodeMode.prepare(`
      const result = await call("native:lookup", { id: input.id })
      return { value: result.value, input: input.id }
    `)
    const calls: string[] = []

    expect(prepared.dependencies).toEqual({
      literalRefs: ["native:lookup"],
      dynamicCallTarget: false,
    })

    const first = await Effect.runPromise(
      CodeMode.executePrepared(prepared, {
        input: { id: "a" },
        call: (ref, value) => {
          calls.push(`${ref}:${(value as { id: string }).id}`)
          return Effect.succeed({ value: 1 })
        },
      }),
    )
    const second = await Effect.runPromise(
      CodeMode.executePrepared(prepared, {
        input: { id: "b" },
        call: (ref, value) => {
          calls.push(`${ref}:${(value as { id: string }).id}`)
          return Effect.succeed({ value: 2 })
        },
      }),
    )

    expect(first).toMatchObject({ ok: true, value: { value: 1, input: "a" } })
    expect(second).toMatchObject({ ok: true, value: { value: 2, input: "b" } })
    expect(calls).toEqual(["native:lookup:a", "native:lookup:b"])
  })

  test("extracts sorted unique literal host-call refs and flags computed targets", () => {
    const prepared = CodeMode.prepare(`
      await call("mcp:github/list_issues", {})
      await call("native:find", {})
      await call("native:find", { again: true })
      return await call(input.ref, {})
    `)

    expect(prepared.dependencies).toEqual({
      literalRefs: ["mcp:github/list_issues", "native:find"],
      dynamicCallTarget: true,
    })
  })

  test("does not mistake a function parameter named call for the host capability bridge", () => {
    const prepared = CodeMode.prepare(`
      const local = (call) => call("not-a-host-ref", {})
      local((name) => name)
      return await call("native:read", {})
    `)

    expect(prepared.dependencies).toEqual({
      literalRefs: ["native:read"],
      dynamicCallTarget: false,
    })
  })

  test("shares operation fuel monotonically across prepared interpreter frames", async () => {
    const prepared = CodeMode.prepare("let total = 0; for (let i = 0; i < 5; i++) total += i; return total")
    const limits = { maxOperations: 10_000 }
    const budget = CodeMode.createExecutionBudget(limits)
    const before = budget.remainingOperations!

    const first = await Effect.runPromise(CodeMode.executePrepared(prepared, { limits, budget }))
    const afterFirst = budget.remainingOperations!
    const second = await Effect.runPromise(CodeMode.executePrepared(prepared, { limits, budget }))
    const afterSecond = budget.remainingOperations!

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(afterFirst).toBeLessThan(before)
    expect(afterSecond).toBeLessThan(afterFirst)
  })

  test("shares aggregate host-result admission across prepared interpreter frames", async () => {
    const prepared = CodeMode.prepare('return await call("native:data", {})')
    const limits = {
      maxIntermediateLeafBytes: 64,
      maxIntermediateAggregateBytes: 20,
    }
    const budget = CodeMode.createExecutionBudget(limits)
    const options = {
      limits,
      budget,
      call: () => Effect.succeed("1234567890"),
    }

    const first = await Effect.runPromise(CodeMode.executePrepared(prepared, options))
    const second = await Effect.runPromise(CodeMode.executePrepared(prepared, options))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("LimitExceeded")
    expect(budget.externalData?.remainingAggregateBytes).toBeLessThan(20)
  })
})
