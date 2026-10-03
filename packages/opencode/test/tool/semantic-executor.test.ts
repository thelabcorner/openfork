import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

/**
 * WP0.5 - raw semantic invocation vs provider delivery.
 *
 * `Tool.Def.execute` is provider delivery: model-facing truncation, then `orDie`.
 * `Tool.InitializedDef.semantic` is the same decoded input and the same leaf,
 * with neither. These tests pin the split itself, because the future capability
 * invocation gateway depends on an expected failure staying catchable, a genuine
 * defect staying a defect, and internal composition never reaching the provider
 * truncation path.
 */

class PolicyDenied extends Schema.TaggedErrorClass<PolicyDenied>()("PolicyDenied", {
  message: Schema.String,
}) {}

const parameters = Schema.Struct({ input: Schema.String })

type Probe = Tool.ExecuteResult<{ count: number }>

function ctx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

/**
 * Counts every provider-delivery projection. A semantic invocation that reached
 * this service would mean internal orchestration silently adopted the
 * model-facing bound, so the count is the assertion rather than the output.
 */
function deliveryCounter() {
  const projected: Array<string> = []
  return {
    projected,
    layer: Layer.mock(Truncate.Service, {
      output: (text: string) =>
        Effect.sync(() => {
          projected.push(text)
          return { content: `[delivered] ${text}`, truncated: false as const }
        }),
    }),
  }
}

async function initialized(info: Effect.Effect<Tool.Info<typeof parameters, { count: number }>, never, unknown>) {
  const counter = deliveryCounter()
  const tool = await Effect.runPromise(
    info.pipe(Effect.flatMap(Tool.init), Effect.provide(counter.layer)) as Effect.Effect<
      Tool.InitializedDef<typeof parameters, { count: number }>,
      never,
      never
    >,
  )
  return { counter, tool }
}

describe("Tool semantic executor", () => {
  test("an expected leaf failure is catchable internally and still fails provider delivery identically", async () => {
    const denial = new PolicyDenied({ message: "permission denied by policy" })
    const { tool } = await initialized(
      Tool.define(
        "denied-probe",
        Effect.succeed({
          description: "probe",
          parameters,
          execute: () => Effect.fail(denial) as Effect.Effect<Probe, PolicyDenied>,
        }),
      ),
    )

    const internal = await Effect.runPromiseExit(tool.semantic({ input: "x" }, ctx()))
    expect(Exit.isFailure(internal)).toBe(true)
    if (!Exit.isFailure(internal)) return
    // Recoverable: it is the expected failure channel, never a defect.
    expect(Cause.squash(internal.cause)).toBe(denial)
    expect(internal.cause.reasons.some(Cause.isFailReason)).toBe(true)
    expect(internal.cause.reasons.some(Cause.isDieReason)).toBe(false)

    const delivered = await Effect.runPromiseExit(tool.execute({ input: "x" }, ctx()))
    expect(Exit.isFailure(delivered)).toBe(true)
    if (!Exit.isFailure(delivered)) return
    // Provider behavior is unchanged: the same typed error, raised as a defect.
    expect(delivered.cause.reasons.some(Cause.isDieReason)).toBe(true)
    expect(Cause.squash(delivered.cause)).toBe(denial)
  })

  test("a genuine leaf defect stays a defect instead of becoming a catchable expected failure", async () => {
    const bug = new Error("host invariant violated")
    const { tool } = await initialized(
      Tool.define(
        "defect-probe",
        Effect.succeed({
          description: "probe",
          parameters,
          execute: (): Effect.Effect<Probe> => Effect.die(bug),
        }),
      ),
    )

    const internal = await Effect.runPromiseExit(tool.semantic({ input: "x" }, ctx()))
    expect(Exit.isFailure(internal)).toBe(true)
    if (!Exit.isFailure(internal)) return
    expect(internal.cause.reasons.some(Cause.isDieReason)).toBe(true)
    expect(internal.cause.reasons.some(Cause.isFailReason)).toBe(false)
    expect(Cause.squash(internal.cause)).toBe(bug)
  })

  test("provider delivery truncates exactly once while internal invocation never reaches that path", async () => {
    const { counter, tool } = await initialized(
      Tool.define(
        "structured-probe",
        Effect.succeed({
          description: "probe",
          parameters,
          execute: (args: Schema.Schema.Type<typeof parameters>) =>
            Effect.succeed<Probe>({
              title: "probe",
              metadata: { count: 1 },
              output: `row:${args.input}`,
              data: { rows: [{ path: "a.ts", line: 1, text: args.input }], total: 1 },
            }),
        }),
      ),
    )

    expect(counter.projected).toEqual([])

    const internal = await Effect.runPromise(tool.semantic({ input: "needle" }, ctx()))
    expect(counter.projected).toEqual([])
    expect(internal.output).toBe("row:needle")

    const delivered = await Effect.runPromise(tool.execute({ input: "needle" }, ctx()))
    expect(counter.projected).toEqual(["row:needle"])
    expect(delivered.output).toBe("[delivered] row:needle")
  })

  test("structured data survives internal composition and crosses delivery unprojected", async () => {
    const { tool } = await initialized(
      Tool.define(
        "payload-probe",
        Effect.succeed({
          description: "probe",
          parameters,
          execute: (args: Schema.Schema.Type<typeof parameters>) =>
            Effect.succeed<Probe>({
              title: "probe",
              metadata: { count: 1 },
              output: args.input,
              data: { rows: [{ path: "a.ts", line: 1, text: args.input }], total: 1 },
            }),
        }),
      ),
    )

    const internal = await Effect.runPromise(tool.semantic({ input: "needle" }, ctx()))
    // A composing caller reads `data`; it never has to parse `output`.
    const data = internal.data as { rows: Array<{ text: string }>; total: number }
    expect(data.rows[0]?.text).toBe("needle")
    expect(data.total).toBe(1)

    const delivered = await Effect.runPromise(tool.execute({ input: "needle" }, ctx()))
    expect(delivered.data).toEqual(data)
  })

  test("invalid arguments are a typed expected failure on the semantic seam, not a decode defect", async () => {
    const counter = deliveryCounter()
    const tool = await Effect.runPromise(
      Tool.define(
        "strict-probe",
        Effect.succeed({
          description: "probe",
          parameters: Schema.Struct({ count: Schema.Number }),
          execute: (): Effect.Effect<Probe> => Effect.succeed({ title: "probe", metadata: { count: 1 }, output: "ok" }),
        }),
      ).pipe(Effect.flatMap(Tool.init), Effect.provide(counter.layer)),
    )

    const internal = await Effect.runPromiseExit(tool.semantic({ count: "not-a-number" } as never, ctx()))
    expect(Exit.isFailure(internal)).toBe(true)
    if (!Exit.isFailure(internal)) return
    expect(internal.cause.reasons.some(Cause.isDieReason)).toBe(false)
    expect(Cause.squash(internal.cause)).toBeInstanceOf(Tool.InvalidArgumentsError)
    expect((Cause.squash(internal.cause) as Tool.InvalidArgumentsError).tool).toBe("strict-probe")
  })
})