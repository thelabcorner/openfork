import { describe, expect, test } from "bun:test"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool, ToolError, toolError } from "../src/index.js"

/**
 * WP0.5 - host tool failure classification at the sandbox boundary.
 *
 * `runHost` owns one distinction: a typed host failure is a recoverable tool
 * refusal, while a genuine host defect is not. Interruption must win over both,
 * including when it arrives together with a failure, so that a cancelled root
 * never resurfaces as an ordinary model-visible tool error.
 */

const probe = (run: () => Effect.Effect<string, ToolError>) =>
  Tool.make({
    description: "Host probe",
    input: Schema.Struct({}),
    output: Schema.String,
    run,
  })

describe("CodeMode host interruption and failure classification", () => {
  test("a host failure mixed with interruption stays an interruption at the host boundary", async () => {
    const exit = await Effect.runPromiseExit(
      CodeMode.make({
        tools: {
          host: {
            call: probe(() => Effect.failCause(Cause.combine(Cause.fail(toolError("Refused")), Cause.interrupt()))),
          },
        },
      }).execute(`
        try {
          await tools.host.call({})
          return { caught: false }
        } catch (e) {
          return { caught: true, message: e.message }
        }
      `),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    // Interruption wins, and it wins over the program's own try/catch: the mixed
    // cause is not program data and never becomes a catchable tool refusal.
    // `hasInterruptsOnly` is false for the original mixed cause, so a
    // squash-based boundary would instead have produced "Refused" as a settled
    // tool failure the program could swallow.
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(Cause.pretty(exit.cause)).not.toMatch(/Refused/)
  })

  test("an expected host failure is a settled tool failure and stays program-catchable", async () => {
    const outcomes: Array<string | undefined> = []
    const result = await Effect.runPromise(
      CodeMode.make({
        tools: { host: { call: probe(() => Effect.fail(toolError("Refused"))) } },
        onToolCallEnd: (call) =>
          Effect.sync(() => {
            outcomes.push(call.outcome)
          }),
      }).execute(`
        try {
          await tools.host.call({})
          return "no"
        } catch (e) {
          return { caught: true, message: e.message }
        }
      `),
    )

    expect(outcomes).toEqual(["failure"])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ caught: true, message: "Refused" })
  })

  test("a genuine host defect is not a settled tool failure and stays sanitized", async () => {
    const outcomes: Array<string | undefined> = []
    const result = await Effect.runPromise(
      CodeMode.make({
        tools: {
          host: {
            call: probe(() => Effect.die(new Error("postgres://user:defect-secret@example.invalid"))),
          },
        },
        onToolCallEnd: (call) =>
          Effect.sync(() => {
            outcomes.push(call.outcome)
          }),
      }).execute("return await tools.host.call({})"),
    )

    // A defect is not a settled tool failure, so it is never reported as one and
    // never acquires a model-facing recovery message.
    expect(outcomes).toEqual([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toStrictEqual({ kind: "ToolFailure", message: "Tool execution failed" })
    expect(JSON.stringify(result)).not.toMatch(/defect-secret/)
  })
})