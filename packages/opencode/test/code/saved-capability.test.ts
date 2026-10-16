import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type * as Tool from "@/tool/tool"
import * as Capability from "@/tool/capability"
import * as Revision from "@/code/revision"
import * as SavedCapability from "@/code/saved-capability"
import * as CodeExecution from "@/code/execution"
import type { LoadedRevision } from "@/code/saved"

const attachment = { type: "file" as const, mime: "text/plain", url: "data:text/plain;base64,b2s=" }

function native(
  id: string,
  inputSchema: object = { type: "object", properties: {} },
): Capability.Registration {
  return {
    identity: Capability.nativeIdentity(id),
    kind: "native",
    description: id,
    inputSchema,
    authorize: () => Effect.void,
    invokeSemantic: () => Effect.succeed({ title: id, metadata: {}, output: "ok" }),
    authorityBinding: `native:${id}:v1`,
    classifyWorkspaceMutation: () => false,
    codeCallable: true,
    lifetime: "inline",
  }
}

function item(input: {
  id: string
  source: string
  inputSchema?: object
  outputSchema?: object
  dependencies?: readonly Revision.Dependency[]
  admitted?: boolean
}): LoadedRevision {
  const spec = {
    name: input.id,
    ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  }
  const derived = Revision.derive({
    source: input.source,
    spec,
    dependencies: input.dependencies ?? [],
  })
  const manifest = Revision.manifest({
    derived,
    spec,
    origin: { run: `run:prt_${input.id}`, session: "ses_saved", message: "msg_saved" },
  })
  return {
    scope: "project",
    scopeKey: "/project",
    id: input.id,
    revision: derived.revision,
    handle: Capability.savedIdentity("project", input.id, derived.revision).ref,
    root: `/project/.openfork/code/${input.id}`,
    source: derived.source,
    envelope: derived.envelope,
    manifest,
    admitted: input.admitted ?? true,
    ...(input.admitted === false
      ? { diagnostic: { kind: "SavedToolDirty" as const, message: "not admitted" } }
      : {}),
  }
}

function context(options?: {
  asks?: Array<{ permission: string; patterns: readonly string[] }>
  invoke?: (ref: string, args: unknown) => Effect.Effect<Tool.ExecuteResult, unknown>
}): Tool.Context {
  const asks = options?.asks
  const base: Tool.Context = {
    sessionID: SessionID.make("ses_saved_capability"),
    messageID: MessageID.ascending(),
    partID: PartID.ascending(),
    callID: "call-saved",
    agent: "build",
    abort: new AbortController().signal,
    permissionRuleset: [],
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks?.push({ permission: request.permission, patterns: request.patterns })
      }),
    invokeCapability: options?.invoke,
  }
  return CodeExecution.withBudget(base, CodeExecution.createRootBudget())
}

async function failed<A>(effect: Effect.Effect<A, unknown>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.map(() => undefined),
      Effect.catch((cause) => Effect.succeed(cause)),
    ),
  )
}

describe("saved Code capability registrations", () => {
  test("validates input before asking permission and uses exact revision identity", async () => {
    const saved = item({
      id: "lookup",
      source: "return input.id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    })
    const [registration] = SavedCapability.registrations([saved], [])
    const asks: Array<{ permission: string; patterns: readonly string[] }> = []
    const ctx = context({ asks })

    const invalid = await failed(registration.invokeSemantic({}, ctx))
    expect(invalid).toBeDefined()
    expect(asks).toEqual([])

    const result = await Effect.runPromise(registration.invokeSemantic({ id: "abc" }, ctx))
    expect(result.data).toBe("abc")
    expect(asks).toEqual([
      {
        permission: "code",
        patterns: [`call:project:lookup@${saved.revision}`],
      },
    ])
  })

  test("exact revalidation rejects a stale admitted snapshot before semantic permission ask", async () => {
    const saved = item({ id: "revoked", source: "return 1" })
    const [registration] = SavedCapability.registrations([saved], [], {
      resolveExact: () => Effect.fail(new Error("admission revoked")),
    })
    const asks: Array<{ permission: string; patterns: readonly string[] }> = []

    const error = await failed(registration.invokeSemantic({}, context({ asks })))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("exact revalidation failed")
    expect((error as Error).message).toContain("admission revoked")
    expect(asks).toEqual([])
  })

  test("caches one exact verified immutable revision per Code root and revalidates a new root", async () => {
    const saved = item({ id: "verified_once", source: "return input.value", inputSchema: { type: "object" } })
    let resolutions = 0
    const [registration] = SavedCapability.registrations([saved], [], {
      resolveExact: () =>
        Effect.sync(() => {
          resolutions += 1
          return saved
        }),
    })
    const firstRoot = context()

    await Effect.runPromise(
      registration.authorize({
        authority: { ruleset: [] },
        args: { value: 1 },
        context: firstRoot,
      }),
    )
    await Effect.runPromise(registration.invokeSemantic({ value: 1 }, firstRoot))
    await Effect.runPromise(registration.invokeSemantic({ value: 2 }, firstRoot))
    expect(resolutions).toBe(1)

    const secondRoot = context()
    await Effect.runPromise(registration.invokeSemantic({ value: 3 }, secondRoot))
    expect(resolutions).toBe(2)
  })

  test("rejects exact resolver output whose immutable source no longer matches the admitted envelope", async () => {
    const saved = item({ id: "tampered", source: "return 1" })
    const tampered: LoadedRevision = { ...saved, source: "return 2" }
    const [registration] = SavedCapability.registrations([saved], [], {
      resolveExact: () => Effect.succeed(tampered),
    })

    const error = await failed(registration.invokeSemantic({}, context()))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("source hash")
  })

  test("inherits one root execution budget and propagates nested data plus attachments", async () => {
    const child = native("child")
    const deps = Revision.dependencies({
      refs: [child.identity.ref],
      dynamicCallTarget: false,
      inventory: { generation: "g", entries: [child] },
      scope: "project",
    })
    const saved = item({
      id: "compose",
      source: `const x = await call("${child.identity.ref}", {}); return { value: x.value }`,
      dependencies: deps,
      outputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    })
    const [registration] = SavedCapability.registrations([saved], [child])
    const ctx = context({
      invoke: (ref) => {
        expect(ref).toBe(child.identity.ref)
        return Effect.succeed({
          title: "child",
          metadata: {},
          output: "fallback",
          data: { value: 42 },
          attachments: [attachment],
        })
      },
    })
    const budget = CodeExecution.budgetFrom(ctx)!
    const before = budget.remainingOperations!

    const result = await Effect.runPromise(registration.invokeSemantic({}, ctx))

    expect(result.data).toEqual({ value: 42 })
    expect(result.attachments).toEqual([attachment])
    expect(budget.remainingOperations!).toBeLessThan(before)
  })

  test("rejects a saved result that violates its declared output schema", async () => {
    const saved = item({
      id: "bad_output",
      source: 'return { count: "wrong" }',
      outputSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    })
    const [registration] = SavedCapability.registrations([saved], [])
    const error = await failed(registration.invokeSemantic({}, context()))
    expect(error).toBeDefined()
  })

  test("marks a saved revision non-callable when a dependency execution contract changes", () => {
    const original = native("read")
    const deps = Revision.dependencies({
      refs: [original.identity.ref],
      dynamicCallTarget: false,
      inventory: { generation: "g1", entries: [original] },
      scope: "project",
    })
    const saved = item({ id: "reader", source: `return await call("${original.identity.ref}", {})`, dependencies: deps })
    const changed = native("read", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })

    const [registration] = SavedCapability.registrations([saved], [changed])
    expect(registration.codeCallable).toBe(false)
    expect(registration.diagnostic?.kind).toBe("DependencyContractChanged")
  })

  test("propagates saved dependency non-callability through the dependency graph", () => {
    const base = native("base")
    const bDeps = Revision.dependencies({
      refs: [base.identity.ref],
      dynamicCallTarget: false,
      inventory: { generation: "g", entries: [base] },
      scope: "project",
    })
    const b = item({ id: "child_saved", source: `return await call("${base.identity.ref}", {})`, dependencies: bDeps })
    const [healthyB] = SavedCapability.registrations([b], [base])

    const aDeps = Revision.dependencies({
      refs: [healthyB.identity.ref],
      dynamicCallTarget: false,
      inventory: { generation: "g2", entries: [healthyB] },
      scope: "project",
    })
    const a = item({ id: "parent_saved", source: `return await call("${healthyB.identity.ref}", {})`, dependencies: aDeps })

    const changedBase = native("base", {
      type: "object",
      properties: { changed: { type: "boolean" } },
      required: ["changed"],
    })
    const registrations = SavedCapability.registrations([a, b], [changedBase])
    const byID = new Map(registrations.map((registration) => [registration.identity.segments[1], registration]))

    expect(byID.get("child_saved")?.codeCallable).toBe(false)
    expect(byID.get("parent_saved")?.codeCallable).toBe(false)
    expect(byID.get("parent_saved")?.diagnostic?.kind).toBe("DependencyContractChanged")
  })

  test("configured deny fails in authorize before semantic permission ask", async () => {
    const saved = item({ id: "denied", source: "return 1" })
    const [registration] = SavedCapability.registrations([saved], [])
    const denied = registration.authorize({
      authority: {
        ruleset: [
          {
            permission: "code",
            pattern: `call:project:denied@${saved.revision}`,
            action: "deny",
          },
        ],
      },
      args: {},
    })
    const error = await failed(denied)
    expect(error).toBeDefined()
  })

  test("saved frames remain read-only delegators and leave mutation ownership to descendants", () => {
    const saved = item({
      id: "delegator",
      source: "return 1",
    })
    const [registration] = SavedCapability.registrations([saved], [])
    expect(registration?.kind).toBe("saved")
    expect(registration?.classifyWorkspaceMutation({})).toBe(false)
  })
})
