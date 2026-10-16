import { beforeEach, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { ToolInterrupt } from "@/tool/interrupt"
import * as Capability from "@/tool/capability"
import * as Gateway from "@/session/capability-invocation-gateway"
import type { Tool } from "@/tool/tool"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Probe: one shared recorder per test, reset by `beforeEach` so no test can
// observe another test's hooks, interrupt entries, or permission asks.
// ---------------------------------------------------------------------------

type LeafProbe = {
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  partID?: PartID
  abort: AbortSignal
  hasSemanticAsk: boolean
}

type Probe = {
  /** Ordered causal record of gateway/registration/fake-service activity. */
  order: string[]
  mutationReasons: string[]
  mutationObserved: number
  rootMetadata: number
  rootAsks: number
  tracked: { sessionID: string; callID: string }[]
  released: { sessionID: string; callID: string }[]
  killed: { sessionID: string; callID: string }[]
  hooks: { name: string; tool: string; callID?: string }[]
  asks: PermissionV1.AskInput[]
  askOutcome: "allow" | "deny"
  /** Signalled by the fake `permission.ask` once it has recorded the request. */
  askReached?: Deferred.Deferred<void>
  leaves: (LeafProbe | undefined)[]
}

function freshProbe(): Probe {
  return {
    order: [],
    mutationReasons: [],
    mutationObserved: 0,
    rootMetadata: 0,
    rootAsks: 0,
    tracked: [],
    released: [],
    killed: [],
    hooks: [],
    asks: [],
    askOutcome: "allow",
    // Explicitly cleared: Object.assign only copies keys the source owns, so a
    // stale ask gate cannot leak a blocking ask into a later test.
    askReached: undefined,
    leaves: [],
  }
}

const probe = freshProbe()
/** Faithful stand-in for ToolInterrupt's real entry bookkeeping. */
const interruptEntries = new Map<string, AbortController>()

beforeEach(() => {
  Object.assign(probe, freshProbe())
  interruptEntries.clear()
})

// Matches ToolInterrupt's session/call disambiguation: ids are opaque strings,
// so a unit separator keeps (session, call) pairs unambiguous.
const interruptKey = (sessionID: string, callID: string) => `${sessionID}\u0000${callID}`

function snapshotLayer() {
  return Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: () => Effect.succeed(undefined),
      invalidate: () => Effect.void,
      // A mutating leaf must enter exactly one mutation section, and that
      // section must close on both the success and the failure path.
      withMutation: (effect, reason) =>
        Effect.sync(() => {
          probe.order.push(`mutate:start:${reason ?? ""}`)
          probe.mutationReasons.push(reason ?? "")
        }).pipe(
          Effect.andThen(effect),
          Effect.onExit(() =>
            Effect.sync(() => {
              probe.order.push(`mutate:end:${reason ?? ""}`)
            }),
          ),
        ),
      diagnostics: () =>
        Effect.succeed({
          revision: 0,
          captures: 0,
          cacheHits: 0,
          invalidations: 0,
          completedReuse: false,
          watcherOwnedRoot: false,
        }),
      patch: () => Effect.die("unused"),
      restore: () => Effect.die("unused"),
      revert: () => Effect.die("unused"),
      diff: () => Effect.die("unused"),
      diffSummary: () => Effect.die("unused"),
      diffFullBounded: () => Effect.die("unused"),
      diffFull: () => Effect.die("unused"),
    } satisfies Snapshot.Interface),
  )
}

function interruptLayer() {
  return Layer.succeed(
    ToolInterrupt.Service,
    ToolInterrupt.Service.of({
      track: (input) =>
        Effect.sync(() => {
          probe.tracked.push({ sessionID: input.sessionID, callID: input.callID })
          const key = interruptKey(input.sessionID, input.callID)
          const existing = interruptEntries.get(key)
          if (existing) return existing.signal
          const controller = new AbortController()
          if (input.parent.aborted) controller.abort(input.parent.reason)
          else input.parent.addEventListener("abort", () => controller.abort(input.parent.reason), { once: true })
          interruptEntries.set(key, controller)
          return controller.signal
        }),
      kill: (input) =>
        Effect.sync(() => {
          probe.killed.push({ sessionID: input.sessionID, callID: input.callID })
          const controller = interruptEntries.get(interruptKey(input.sessionID, input.callID))
          if (!controller || controller.signal.aborted) return false
          controller.abort()
          return true
        }),
      release: (input) =>
        Effect.sync(() => {
          probe.released.push({ sessionID: input.sessionID, callID: input.callID })
          interruptEntries.delete(interruptKey(input.sessionID, input.callID))
        }),
    } satisfies ToolInterrupt.Interface),
  )
}

function pluginLayer() {
  return Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (name, input, output) =>
        Effect.sync(() => {
          if (name === "tool.execute.before" || name === "tool.execute.after") {
            const hook = input as { tool?: string; callID?: string }
            probe.hooks.push({
              name,
              tool: hook.tool ?? "",
              ...(hook.callID === undefined ? {} : { callID: hook.callID }),
            })
            probe.order.push(`hook:${name === "tool.execute.before" ? "before" : "after"}:${hook.tool ?? ""}`)
          }
          return output
        }),
      transformChatMessages: (messages) => Effect.succeed(messages),
    } satisfies Plugin.Interface),
  )
}

// Permission.Service is a required gateway dependency: the gateway performs the
// raw semantic ask itself so a run-scoped denial stays a catchable failure.
const permissionLayer = Layer.mock(Permission.Service, {
  ask: (input) =>
    Effect.suspend((): Effect.Effect<void, PermissionV1.Error> => {
      probe.asks.push(input)
      probe.order.push(`ask:${input.permission}`)
      const reached = probe.askReached
      if (reached) {
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              probe.order.push("ask:finalized")
            }),
          ),
        )
      }
      return probe.askOutcome === "deny"
        ? Effect.fail(new PermissionV1.DeniedError({ ruleset: input.ruleset }))
        : Effect.void
    }),
})

const it = testEffect(Layer.mergeAll(snapshotLayer(), interruptLayer(), pluginLayer(), permissionLayer))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERMISSION_RULESET: PermissionV1.Ruleset = [{ permission: "gateway_probe", pattern: "*", action: "ask" }]

function inventory(...registrations: Capability.Registration[]): Gateway.CapabilitySnapshot {
  // Uses the real production builder so snapshot identity/freeze/duplicate
  // behavior is exercised rather than re-implemented by the test.
  return Gateway.fromInventory({ generation: "gen-test", entries: registrations })
}

function rootContext(options?: {
  abort?: AbortSignal
  callID?: string
  partID?: PartID
  permissionRuleset?: PermissionV1.Ruleset
}): Tool.Context {
  return {
    sessionID: SessionID.make("ses_gateway"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: options?.abort ?? new AbortController().signal,
    callID: options?.callID ?? "call-root",
    partID: options?.partID ?? PartID.ascending(),
    permissionRuleset: options?.permissionRuleset ?? PERMISSION_RULESET,
    messages: [],
    // Root metadata/ask belong to the real provider ToolPart. A nested leaf must
    // never reach them: leaf progress targets only the bounded Code trace.
    metadata: () =>
      Effect.sync(() => {
        probe.rootMetadata += 1
      }),
    ask: () =>
      Effect.sync(() => {
        probe.rootAsks += 1
      }),
    markWorkspaceMutation: () =>
      Effect.sync(() => {
        probe.mutationObserved += 1
      }),
  }
}

type RegistrationOptions = {
  identity?: Capability.Identity
  kind?: Capability.Kind
  permissionKey?: string
  delegatesTo?: readonly string[]
  diagnostic?: { readonly kind: string; readonly message: string }
  codeCallable?: boolean
  mutates?: boolean | ((args: unknown) => boolean)
  authorize?: (input: {
    readonly authority: Capability.InvocationAuthority
    readonly args: unknown
  }) => Effect.Effect<void, unknown>
  semantic?: (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult, unknown>
}

const PROBE_ATTACHMENT = { type: "file" as const, mime: "text/plain", url: "data:text/plain;base64,b2s=" }

function registration(options?: RegistrationOptions): Capability.Registration {
  const identity = options?.identity ?? Capability.nativeIdentity("gateway_probe")
  const kind = options?.kind ?? "native"
  return {
    identity,
    kind,
    description: "gateway probe",
    inputSchema: { type: "object", properties: {} },
    ...(options?.permissionKey === undefined ? {} : { permissionKey: options.permissionKey }),
    ...(options?.delegatesTo === undefined ? {} : { delegatesTo: options.delegatesTo }),
    ...(options?.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    invokeSemantic: (args, ctx) =>
      options?.semantic
        ? options.semantic(args, ctx)
        : Effect.succeed({
            title: "probe",
            metadata: { semantic: true },
            output: "ok",
            data: { value: 1 },
            attachments: [PROBE_ATTACHMENT],
          }),
    authorize: (input) => {
      probe.order.push("authorize")
      return options?.authorize?.(input) ?? Effect.void
    },
    authorityBinding: `${kind}:${identity.ref}`,
    classifyWorkspaceMutation: (args) =>
      typeof options?.mutates === "function" ? options.mutates(args) : (options?.mutates ?? false),
    codeCallable: options?.codeCallable ?? true,
    lifetime: "inline",
  } satisfies Capability.Registration
}

/**
 * Default leaf: records the identity/abort it was handed, writes progress
 * through `ctx.metadata`, and emits structured data plus an attachment.
 */
function leaf(index: number) {
  return (args: unknown, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult, unknown> =>
    Effect.gen(function* () {
      const leafIndex = (args as { index?: number } | undefined)?.index ?? index
      probe.leaves[leafIndex] = {
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        ...(ctx.callID === undefined ? {} : { callID: ctx.callID }),
        ...(ctx.partID === undefined ? {} : { partID: ctx.partID }),
        abort: ctx.abort,
        hasSemanticAsk: typeof ctx.semanticAsk === "function",
      }
      probe.order.push(`leaf-${leafIndex}:start`)
      yield* ctx.metadata({ title: `leaf-${leafIndex}`, metadata: { leaf: leafIndex } })
      probe.order.push(`leaf-${leafIndex}:end`)
      return {
        title: `leaf-${leafIndex}`,
        metadata: { leaf: leafIndex },
        output: `out-${leafIndex}`,
        data: { leaf: leafIndex },
        attachments: [PROBE_ATTACHMENT],
      }
    })
}

function tagOf(error: unknown) {
  return (error as { _tag?: string } | null)?._tag
}

function waitForAbort(signal: AbortSignal): Effect.Effect<never, Error> {
  return Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(new Error("aborted")))
      return
    }
    const onAbort = () => resume(Effect.fail(new Error("aborted")))
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

// ---------------------------------------------------------------------------
// Exact ref resolution
// ---------------------------------------------------------------------------

it.effect("rejects an unknown ref before allocating a frame, interrupt entry, or hook", () =>
  Effect.gen(function* () {
    const reg = registration()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const error = yield* Effect.flip(run.invoke({ ref: "native:absent", args: {} }))

    expect(error).toBeInstanceOf(Gateway.UnknownCapabilityError)
    expect(tagOf(error)).toBe("CapabilityUnknownError")
    expect((error as Gateway.UnknownCapabilityError).ref).toBe("native:absent")
    expect((error as Error).message).toBe("Unknown capability ref: native:absent")

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(0)
    expect(trace.frames).toEqual([])
    expect(probe.tracked).toEqual([])
    expect(probe.hooks).toEqual([])
    expect(probe.order).toEqual([])
  }),
)

it.effect("rejects a non-code-callable ref with the registration diagnostic and no side effects", () =>
  Effect.gen(function* () {
    const reg = registration({
      codeCallable: false,
      diagnostic: { kind: "permission", message: "target explicitly denied" },
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const error = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(error).toBeInstanceOf(Gateway.CapabilityNotCallableError)
    expect(tagOf(error)).toBe("CapabilityNotCallableError")
    expect((error as Gateway.CapabilityNotCallableError).ref).toBe(reg.identity.ref)
    expect((error as Gateway.CapabilityNotCallableError).detail).toBe("permission: target explicitly denied")
    expect((error as Error).message).toBe(
      `Capability ${reg.identity.ref} is not callable from Code: permission: target explicitly denied`,
    )

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(0)
    expect(probe.tracked).toEqual([])
    expect(probe.released).toEqual([])
    expect(probe.hooks).toEqual([])
    expect(probe.order).toEqual([])
  }),
)

it.effect("omits the diagnostic detail when the registration carries none", () =>
  Effect.gen(function* () {
    const reg = registration({ codeCallable: false })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const error = (yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))) as Error

    expect(error).toBeInstanceOf(Gateway.CapabilityNotCallableError)
    expect(error.message).toBe(`Capability ${reg.identity.ref} is not callable from Code`)
  }),
)

it.effect("lets the broker caller reach a capability that is not code-callable", () =>
  Effect.gen(function* () {
    const reg = registration({ codeCallable: false, semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext(), caller: "broker" })

    const result = yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    expect(result.output).toBe("out-0")
    expect((yield* run.trace()).totalCalls).toBe(1)
  }),
)

it.effect("rejects a snapshot whose inventory contains duplicate refs", () =>
  Effect.sync(() => {
    const reg = registration()
    expect(() => Gateway.fromInventory({ generation: "gen-test", entries: [reg, reg] })).toThrow(
      `Duplicate capability ref in inventory snapshot: ${reg.identity.ref}`,
    )
  }),
)

it.effect("preserves the immutable captured snapshot on the opened run", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const snapshot = inventory(reg)
    const run = yield* Gateway.open({ snapshot, context: rootContext() })

    expect(run.snapshot).toBe(snapshot)
    expect(run.snapshot.generation).toBe("gen-test")
    expect(Object.isFrozen(run.snapshot.entries)).toBe(true)
    expect(run.snapshot.byRef.get(reg.identity.ref)).toBe(reg)
  }),
)

// ---------------------------------------------------------------------------
// Authorization strictly precedes Snapshot mutation
// ---------------------------------------------------------------------------

it.effect("runs authorization before marking the root mutated, entering Snapshot, or firing hooks", () =>
  Effect.gen(function* () {
    const reg = registration({ mutates: true, semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    expect(probe.order).toEqual([
      "authorize",
      "mutate:start:capability:native:gateway_probe",
      "hook:before:gateway_probe",
      "leaf-0:start",
      "leaf-0:end",
      "hook:after:gateway_probe",
      "mutate:end:capability:native:gateway_probe",
    ])
    expect(probe.mutationObserved).toBe(1)
  }),
)

it.effect("skips Snapshot mutation, root marking, and hooks when authorization denies", () =>
  Effect.gen(function* () {
    let invoked = 0
    const denial = new PermissionV1.DeniedError({
      ruleset: [{ permission: "gateway_probe", pattern: "*", action: "deny" }],
    })
    const reg = registration({
      mutates: true,
      authorize: () => Effect.fail(denial),
      semantic: () =>
        Effect.sync(() => {
          invoked += 1
          return { title: "bad", metadata: {}, output: "bad" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const error = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(error).toBe(denial)
    expect(invoked).toBe(0)
    expect(probe.order).toEqual(["authorize"])
    expect(probe.mutationReasons).toEqual([])
    expect(probe.mutationObserved).toBe(0)
    expect(probe.hooks).toEqual([])

    const trace = yield* run.trace()
    expect(trace.frames).toHaveLength(1)
    expect(trace.frames[0]?.status).toBe("failed")
    // Authorization still consumed a frame identity and released its interrupt.
    expect(probe.released).toEqual(probe.tracked)
  }),
)

it.effect("keeps an admission denial a catchable failure rather than a host defect", () =>
  Effect.gen(function* () {
    const denial = new PermissionV1.RejectedError()
    const reg = registration({ authorize: () => Effect.fail(denial) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const exit = yield* Effect.exit(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(Cause.squash(exit.cause)).toBe(denial)
  }),
)

it.effect("passes the current session+agent ruleset and run scope into authorization", () =>
  Effect.gen(function* () {
    let seen: Capability.InvocationAuthority | undefined
    const reg = registration({
      authorize: (input) =>
        Effect.sync(() => {
          seen = input.authority
        }),
    })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root, executionID: "exec-7" })

    yield* run.invoke({ ref: reg.identity.ref, args: { probe: true } })

    expect(seen?.ruleset).toBe(root.permissionRuleset)
    expect(seen?.executionID).toBe("exec-7")
  }),
)

// ---------------------------------------------------------------------------
// Root identity preserved / frame identity distinct
// ---------------------------------------------------------------------------

it.effect("keeps the root callID/partID for every leaf while deriving distinct frame identities", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root, executionID: "exec-1" })

    yield* Effect.all(
      [0, 1, 2].map((index) => run.invoke({ ref: reg.identity.ref, args: { index } })),
      { concurrency: "unbounded" },
    )

    for (const index of [0, 1, 2]) {
      expect(probe.leaves[index]?.callID).toBe(root.callID)
      expect(probe.leaves[index]?.partID).toBe(root.partID)
      expect(probe.leaves[index]?.sessionID).toBe(root.sessionID)
      expect(probe.leaves[index]?.messageID).toBe(root.messageID)
    }

    // Frame identity is separate, monotonic, and never the root callID.
    const trackedIDs = probe.tracked.map((entry) => entry.callID)
    expect(trackedIDs).toHaveLength(3)
    expect(new Set(trackedIDs)).toEqual(new Set(["call-root#1", "call-root#2", "call-root#3"]))
    for (const id of trackedIDs) expect(id).not.toBe(root.callID)

    const trace = yield* run.trace()
    expect(trace.frames).toHaveLength(3)
    expect(new Set(trace.frames.map((frame) => frame.frameID)).size).toBe(3)
    for (const index of [0, 1, 2]) {
      const frame = trace.frames.find((candidate) => candidate.title === `leaf-${index}`)
      expect(frame).toBeDefined()
      expect(frame?.ref).toBe(reg.identity.ref)
      expect(frame?.depth).toBe(0)
      expect(frame?.status).toBe("succeeded")
    }

    // Each frame releases exactly its own interrupt entry, exactly once.
    expect(probe.released.map((entry) => entry.callID).sort()).toEqual([...trackedIDs].sort())
    expect(probe.released).toHaveLength(3)
  }),
)

it.effect("records a declared parent frame identity and nesting depth", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 }, parentFrameID: "call-root#7", depth: 2 })

    const trace = yield* run.trace()
    expect(trace.frames[0]?.parentFrameID).toBe("call-root#7")
    expect(trace.frames[0]?.depth).toBe(2)
    expect(trace.frames[0]?.frameID).toBe("call-root#1")
  }),
)

it.effect("never reaches the root metadata or root ask hooks", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.metadata({ title: "nested", metadata: { step: 1 } })
          yield* ctx.ask({ permission: "gateway_probe", patterns: ["*"], always: [], metadata: {} })
          return { title: "nested", metadata: {}, output: "nested" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect(probe.rootMetadata).toBe(0)
    expect(probe.rootAsks).toBe(0)
    expect(probe.asks).toHaveLength(1)
  }),
)

it.effect("100 nested leaves produce zero root metadata publications", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxCalls: 128, maxConcurrency: 8, maxTraceFrames: 128 },
    })

    yield* Effect.forEach(
      Array.from({ length: 100 }, (_, index) => index),
      (index) => run.invoke({ ref: reg.identity.ref, args: { index } }),
      { concurrency: 8, discard: true },
    )

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(100)
    expect(trace.frames).toHaveLength(100)
    expect(probe.rootMetadata).toBe(0)
    expect(probe.rootAsks).toBe(0)
    expect(probe.tracked).toHaveLength(100)
    expect(probe.released).toHaveLength(100)
  }),
)

// ---------------------------------------------------------------------------
// Permission ask: run scope + root tool identity
// ---------------------------------------------------------------------------

const ASK_INPUT = { permission: "gateway_probe", patterns: ["src/**/*.ts"], always: ["src/**/*.ts"] }

it.effect("stamps the run executionID, session, root tool identity, and ruleset on a leaf ctx.ask", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ ...ASK_INPUT, metadata: { reason: "nested write" } })
          return { title: "asked", metadata: {}, output: "asked" }
        }),
    })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root, executionID: "exec-42" })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect(probe.asks).toHaveLength(1)
    const ask = probe.asks[0]!
    expect(ask.sessionID).toBe(root.sessionID)
    expect(ask.executionID).toBe("exec-42")
    expect(ask.permission).toBe("gateway_probe")
    expect(ask.patterns).toEqual(["src/**/*.ts"])
    expect(ask.always).toEqual(["src/**/*.ts"])
    expect(ask.metadata).toEqual({ reason: "nested write" })
    expect(ask.ruleset).toBe(root.permissionRuleset!)
    // Permission/question UI must resolve to the real root ToolPart identity.
    expect(ask.tool).toEqual({ messageID: root.messageID, callID: root.callID! })
  }),
)

it.effect("preserves a leaf-declared executionID instead of overwriting it with the run scope", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ ...ASK_INPUT, executionID: "leaf-exec", metadata: {} })
          return { title: "asked", metadata: {}, output: "asked" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext(), executionID: "exec-root" })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect(probe.asks[0]?.executionID).toBe("leaf-exec")
  }),
)

it.effect("leaves executionID absent when neither the leaf nor the root declares a run scope", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ ...ASK_INPUT, metadata: {} })
          return { title: "asked", metadata: {}, output: "asked" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect("executionID" in probe.asks[0]!).toBe(false)
    expect(probe.asks[0]?.executionID).toBeUndefined()
  }),
)

it.effect("supplies a raw semanticAsk boundary on the leaf context", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          const ask = ctx.semanticAsk
          if (!ask) return { title: "missing", metadata: {}, output: "missing" }
          yield* ask({ ...ASK_INPUT, metadata: {} })
          return { title: "asked", metadata: {}, output: "asked" }
        }),
    })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root, executionID: "exec-1" })

    const result = yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect(result.output).toBe("asked")
    expect(probe.asks).toHaveLength(1)
    expect(probe.asks[0]?.executionID).toBe("exec-1")
    expect(probe.asks[0]?.tool).toEqual({ messageID: root.messageID, callID: root.callID! })
  }),
)

it.effect("surfaces a run-scoped permission denial as a catchable failure from semanticAsk", () =>
  Effect.gen(function* () {
    probe.askOutcome = "deny"
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.semanticAsk!({ ...ASK_INPUT, metadata: {} })
          return { title: "unreachable", metadata: {}, output: "unreachable" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext(), executionID: "exec-1" })

    const error = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(error).toBeInstanceOf(PermissionV1.DeniedError)
    expect(tagOf(error)).toBe("PermissionDeniedError")
    expect((yield* run.trace()).frames[0]?.status).toBe("failed")
  }),
)

it.effect("keeps the ctx.ask denial catchable even though Tool.Context types ask as infallible", () =>
  Effect.gen(function* () {
    probe.askOutcome = "deny"
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ ...ASK_INPUT, metadata: {} })
          return { title: "unreachable", metadata: {}, output: "unreachable" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const exit = yield* Effect.exit(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    // A denial is an expected failure, so it must not leak into the defect channel.
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
  }),
)

// ---------------------------------------------------------------------------
// Plugin hooks: exactly once per semantic frame
// ---------------------------------------------------------------------------

it.effect("fires exactly one before/after hook pair per semantic frame", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    expect(probe.hooks).toEqual([
      { name: "tool.execute.before", tool: "gateway_probe", callID: root.callID },
      { name: "tool.execute.after", tool: "gateway_probe", callID: root.callID },
    ])
    expect(probe.order).toEqual([
      "authorize",
      "hook:before:gateway_probe",
      "leaf-0:start",
      "leaf-0:end",
      "hook:after:gateway_probe",
    ])
  }),
)

it.effect("uses the MCP permission key as the hook identity and falls back to the ref", () =>
  Effect.gen(function* () {
    const keyed = registration({
      identity: Capability.mcpIdentity("srv", "do"),
      kind: "mcp",
      permissionKey: "mcp_srv_do",
      semantic: leaf(0),
    })
    const unkeyed = registration({
      identity: Capability.mcpIdentity("srv", "raw"),
      kind: "mcp",
      semantic: leaf(1),
    })

    const keyedRun = yield* Gateway.open({ snapshot: inventory(keyed), context: rootContext() })
    yield* keyedRun.invoke({ ref: keyed.identity.ref, args: { index: 0 } })
    const unkeyedRun = yield* Gateway.open({ snapshot: inventory(unkeyed), context: rootContext() })
    yield* unkeyedRun.invoke({ ref: unkeyed.identity.ref, args: { index: 1 } })

    expect(probe.hooks.map((hook) => hook.tool)).toEqual(["mcp_srv_do", "mcp_srv_do", "mcp:srv/raw", "mcp:srv/raw"])
  }),
)

it.effect("fires one hook pair per frame when a delegator nests a child through its leaf context", () =>
  Effect.gen(function* () {
    const child = registration({ identity: Capability.nativeIdentity("gateway_child"), semantic: leaf(1) })
    const delegator = registration({
      identity: Capability.nativeIdentity("gateway_parent"),
      delegatesTo: [child.identity.ref],
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          probe.order.push("delegator:enter")
          if (!ctx.invokeCapability) return yield* Effect.die(new Error("nested capability seam missing"))
          const result = yield* ctx.invokeCapability(child.identity.ref, { index: 1 })
          probe.order.push("delegator:exit")
          return { title: "delegator", metadata: { nested: result.output }, output: result.output }
        }),
    })

    const run = yield* Gateway.open({ snapshot: inventory(delegator, child), context: rootContext() })
    const result = yield* run.invoke({ ref: delegator.identity.ref, args: {} })

    expect(result.output).toBe("out-1")
    // Two semantic frames -> two before/after pairs, never a doubled child pair.
    expect(probe.hooks).toEqual([
      { name: "tool.execute.before", tool: "gateway_parent", callID: "call-root" },
      { name: "tool.execute.before", tool: "gateway_child", callID: "call-root" },
      { name: "tool.execute.after", tool: "gateway_child", callID: "call-root" },
      { name: "tool.execute.after", tool: "gateway_parent", callID: "call-root" },
    ])
    expect(probe.order).toEqual([
      "authorize",
      "hook:before:gateway_parent",
      "delegator:enter",
      "authorize",
      "hook:before:gateway_child",
      "leaf-1:start",
      "leaf-1:end",
      "hook:after:gateway_child",
      "delegator:exit",
      "hook:after:gateway_parent",
    ])

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(2)
    expect(trace.frames.map((frame) => frame.frameID)).toEqual(["call-root#1", "call-root#2"])
    expect(trace.frames[1]).toMatchObject({
      parentFrameID: "call-root#1",
      depth: 1,
      ref: child.identity.ref,
    })
    expect(new Set(probe.released.map((entry) => entry.callID))).toEqual(new Set(["call-root#1", "call-root#2"]))
  }),
)

it.effect("rejects a concrete saved-capability cycle before allocating the repeated frame", () =>
  Effect.gen(function* () {
    const revisionA = "sha256:" + "a".repeat(64)
    const revisionB = "sha256:" + "b".repeat(64)
    const identityA = Capability.savedIdentity("project", "saved_a", revisionA)
    const identityB = Capability.savedIdentity("project", "saved_b", revisionB)

    const savedA = registration({
      identity: identityA,
      kind: "saved",
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          if (!ctx.invokeCapability) return yield* Effect.die(new Error("nested capability seam missing"))
          return yield* ctx.invokeCapability(identityB.ref, {})
        }),
    })
    const savedB = registration({
      identity: identityB,
      kind: "saved",
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          if (!ctx.invokeCapability) return yield* Effect.die(new Error("nested capability seam missing"))
          return yield* ctx.invokeCapability(identityA.ref, {})
        }),
    })

    const run = yield* Gateway.open({ snapshot: inventory(savedA, savedB), context: rootContext() })
    const error = yield* Effect.flip(run.invoke({ ref: identityA.ref, args: {} }))

    expect(error).toBeInstanceOf(Gateway.CapabilityCycleError)
    expect((error as Gateway.CapabilityCycleError).ancestry).toEqual([identityA.ref, identityB.ref])
    expect((error as Gateway.CapabilityCycleError).ref).toBe(identityA.ref)

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(2)
    expect(trace.frames.map((frame) => frame.ref)).toEqual([identityA.ref, identityB.ref])
  }),
)

it.effect("allows repeated saved capability calls when they are not recursively nested", () =>
  Effect.gen(function* () {
    const identity = Capability.savedIdentity("project", "repeatable", "sha256:" + "c".repeat(64))
    const saved = registration({
      identity,
      kind: "saved",
      semantic: () => Effect.succeed({ title: "saved", metadata: {}, output: "ok" }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(saved), context: rootContext() })

    expect((yield* run.invoke({ ref: identity.ref, args: {} })).output).toBe("ok")
    expect((yield* run.invoke({ ref: identity.ref, args: {} })).output).toBe("ok")
    expect((yield* run.trace()).totalCalls).toBe(2)
  }),
)

it.effect("does not fire the after hook when the semantic leaf fails", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: () => Effect.fail(new Error("leaf refused")) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(probe.hooks).toEqual([{ name: "tool.execute.before", tool: "gateway_probe", callID: "call-root" }])
    const trace = yield* run.trace()
    expect(trace.frames[0]?.status).toBe("failed")
    expect(probe.released).toHaveLength(1)
  }),
)

// ---------------------------------------------------------------------------
// Mutation classification and Snapshot sections
// ---------------------------------------------------------------------------

it.effect("marks the root and enters Snapshot exactly once for a mutating leaf", () =>
  Effect.gen(function* () {
    const reg = registration({ mutates: true, semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    expect(probe.mutationReasons).toEqual(["capability:native:gateway_probe"])
    expect(probe.mutationObserved).toBe(1)
    expect(probe.order.filter((entry) => entry.startsWith("mutate:start"))).toHaveLength(1)
    expect(probe.order.filter((entry) => entry.startsWith("mutate:end"))).toHaveLength(1)
  }),
)

it.effect("neither marks the root nor enters Snapshot for a read-only leaf", () =>
  Effect.gen(function* () {
    const reg = registration({ mutates: false, semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const result = yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    expect(result.output).toBe("out-0")
    expect(probe.mutationReasons).toEqual([])
    expect(probe.mutationObserved).toBe(0)
    expect(probe.order.some((entry) => entry.startsWith("mutate:"))).toBe(false)
  }),
)

it.effect("classifies mutation from the actual leaf arguments, not a static bit", () =>
  Effect.gen(function* () {
    const reg = registration({
      mutates: (args) => (args as { write?: boolean }).write === true,
      semantic: leaf(0),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0, write: false } })
    expect(probe.mutationReasons).toEqual([])
    expect(probe.mutationObserved).toBe(0)

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0, write: true } })
    expect(probe.mutationReasons).toEqual(["capability:native:gateway_probe"])
    expect(probe.mutationObserved).toBe(1)
  }),
)

it.effect("closes the mutation section and conservatively marks the root when the leaf fails", () =>
  Effect.gen(function* () {
    const reg = registration({ mutates: true, semantic: () => Effect.fail(new Error("write refused")) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(probe.mutationObserved).toBe(1)
    expect(probe.order.filter((entry) => entry.startsWith("mutate:end"))).toHaveLength(1)
  }),
)

it.effect("isolates mutation sections per leaf so a read sibling never observes one", () =>
  Effect.gen(function* () {
    const writer = registration({
      identity: Capability.nativeIdentity("gateway_write"),
      mutates: true,
      semantic: leaf(0),
    })
    const reader = registration({
      identity: Capability.nativeIdentity("gateway_read"),
      mutates: false,
      semantic: leaf(1),
    })
    const run = yield* Gateway.open({ snapshot: inventory(writer, reader), context: rootContext() })

    yield* Effect.all(
      [
        run.invoke({ ref: writer.identity.ref, args: { index: 0 } }),
        run.invoke({ ref: reader.identity.ref, args: { index: 1 } }),
      ],
      { concurrency: "unbounded" },
    )

    expect(probe.mutationReasons).toEqual(["capability:native:gateway_write"])
    expect(probe.mutationObserved).toBe(1)
  }),
)

// ---------------------------------------------------------------------------
// Result projection
// ---------------------------------------------------------------------------

it.effect("preserves structured data and attachments through the gateway", () =>
  Effect.gen(function* () {
    const data = { rows: [1, 2, 3], nested: { ok: true } }
    const attachments = [
      { type: "file" as const, mime: "text/plain", url: "data:text/plain;base64,b2s=" },
      { type: "file" as const, mime: "application/json", url: "data:application/json;base64,e30=" },
    ]
    const reg = registration({
      semantic: () => Effect.succeed({ title: "structured", metadata: { a: 1 }, output: "text", data, attachments }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    const result = yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect(result.output).toBe("text")
    expect(result.metadata).toEqual({ a: 1 })
    expect(result.data).toBe(data)
    expect(result.attachments).toBe(attachments)
    expect((yield* run.trace()).frames[0]?.attachmentCount).toBe(2)
  }),
)

it.effect("reports a zero attachment count for a leaf that returns none", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: () => Effect.succeed({ title: "bare", metadata: {}, output: "bare" }) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect((yield* run.trace()).frames[0]?.attachmentCount).toBe(0)
  }),
)

it.effect("does not project an attachment count onto a failed frame", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: () => Effect.fail(new Error("nope")) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    const frame = (yield* run.trace()).frames[0]
    expect(frame?.status).toBe("failed")
    expect(frame?.attachmentCount).toBeUndefined()
  }),
)

// ---------------------------------------------------------------------------
// Trace bounds
// ---------------------------------------------------------------------------

it.effect("bounds retained trace frames while still counting every call", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxTraceFrames: 2 },
    })

    for (const index of [0, 1, 2, 3]) yield* run.invoke({ ref: reg.identity.ref, args: { index } })

    const trace = yield* run.trace()
    expect(trace.totalCalls).toBe(4)
    expect(trace.frames).toHaveLength(2)
    expect(trace.truncated).toBe(true)
    expect(trace.frames.map((frame) => frame.frameID)).toEqual(["call-root#1", "call-root#2"])
  }),
)

it.effect("bounds per-frame trace metadata bytes and flags the truncation", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.metadata({ title: "big", metadata: { blob: "x".repeat(512) } })
          return { title: "big", metadata: {}, output: "big" }
        }),
    })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxTraceMetadataBytes: 64 },
    })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    const metadata = (yield* run.trace()).frames[0]?.metadata
    expect(metadata?.truncated).toBe(true)
    expect(typeof metadata?.preview).toBe("string")
    expect(JSON.stringify(metadata).length).toBeLessThan(256)
  }),
)

it.effect("passes small trace metadata through unchanged", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.metadata({ title: "small", metadata: { rows: [1, 2], ok: true } })
          return { title: "small", metadata: {}, output: "small" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect((yield* run.trace()).frames[0]?.metadata).toEqual({ rows: [1, 2], ok: true })
  }),
)

it.effect("bounds a leaf trace title", () =>
  Effect.gen(function* () {
    const reg = registration({
      semantic: (_args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.metadata({ title: "t".repeat(300), metadata: {} })
          return { title: "long", metadata: {}, output: "long" }
        }),
    })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: {} })

    expect((yield* run.trace()).frames[0]?.title).toHaveLength(256)
  }),
)

it.effect("records a finished timestamp and duration for a settled frame", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    const frame = (yield* run.trace()).frames[0]
    expect(typeof frame?.finishedAt).toBe("number")
    expect(frame?.durationMs).toBeGreaterThanOrEqual(0)
  }),
)

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

it.effect("enforces the call budget deterministically", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxCalls: 1 },
    })

    expect((yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })).output).toBe("out-0")

    const error = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: { index: 0 } }))
    expect(error).toBeInstanceOf(Gateway.CapabilityCallLimitError)
    expect((error as Gateway.CapabilityCallLimitError).limit).toBe(1)
    expect((error as Error).message).toBe("Capability call limit exceeded (1)")

    expect((yield* run.trace()).totalCalls).toBe(1)
    // A budget rejection allocates no extra frame and no extra interrupt entry.
    expect(probe.tracked).toHaveLength(1)
  }),
)

it.effect("enforces the nesting depth budget before allocating a frame", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxDepth: 2 },
    })

    const error = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {}, depth: 3 }))
    expect(error).toBeInstanceOf(Gateway.CapabilityDepthLimitError)
    expect((error as Gateway.CapabilityDepthLimitError).depth).toBe(3)
    expect((error as Gateway.CapabilityDepthLimitError).limit).toBe(2)
    expect((error as Error).message).toBe("Capability nesting depth 3 exceeds limit 2")

    expect((yield* run.trace()).totalCalls).toBe(0)
    expect(probe.tracked).toEqual([])
    expect(probe.order).toEqual([])

    expect((yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 }, depth: 2 })).output).toBe("out-0")
    const after = yield* run.trace()
    expect(after.totalCalls).toBe(1)
    expect(after.frames[0]?.depth).toBe(2)
  }),
)

it.effect("falls back to the documented defaults for non-positive or non-finite limit overrides", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: leaf(0) })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxCalls: 0, maxDepth: -1, maxTraceFrames: Number.NaN },
    })

    const depthError = yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {}, depth: 17 }))
    expect(depthError).toBeInstanceOf(Gateway.CapabilityDepthLimitError)
    expect((depthError as Gateway.CapabilityDepthLimitError).limit).toBe(Gateway.DEFAULT_LIMITS.maxDepth)

    const budgetError = yield* Effect.flip(
      Effect.gen(function* () {
        for (let index = 0; index <= Gateway.DEFAULT_LIMITS.maxCalls; index += 1) {
          yield* run.invoke({ ref: reg.identity.ref, args: { index } })
        }
        return undefined as unknown
      }),
    )
    expect(budgetError).toBeInstanceOf(Gateway.CapabilityCallLimitError)
    expect((budgetError as Gateway.CapabilityCallLimitError).limit).toBe(Gateway.DEFAULT_LIMITS.maxCalls)
  }),
)

it.live("serializes leaves through the concurrency bound instead of overlapping them", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const reg = registration({
      semantic: () => Deferred.await(gate).pipe(Effect.as({ title: "blocked", metadata: {}, output: "blocked" })),
    })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxConcurrency: 1 },
    })

    const both = Effect.all(
      [
        run.invoke({ ref: reg.identity.ref, args: { index: 0 } }),
        run.invoke({ ref: reg.identity.ref, args: { index: 1 } }),
      ],
      { concurrency: "unbounded" },
    )

    // Both leaves block forever and the gate is never opened, so the pair can
    // only complete if the concurrency bound is violated.
    const error = yield* awaitWithTimeout(both, "leaves must serialize under maxConcurrency 1", "500 millis").pipe(
      Effect.flip,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("leaves must serialize under maxConcurrency 1")
    // Only the first leaf reached admission while it held the sole permit.
    expect(probe.order.filter((entry) => entry === "authorize")).toHaveLength(1)
    expect(probe.tracked).toHaveLength(1)
  }),
)

it.effect("fan-out overlaps up to the configured shared-root concurrency cap", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const fourStarted = yield* Deferred.make<void>()
    let active = 0
    let maximum = 0
    let started = 0
    const reg = registration({
      semantic: () =>
        Effect.gen(function* () {
          started += 1
          active += 1
          maximum = Math.max(maximum, active)
          if (started === 4) yield* Deferred.succeed(fourStarted, undefined)
          yield* Deferred.await(release)
          active -= 1
          return { title: "fanout", metadata: {}, output: "ok" }
        }),
    })
    const run = yield* Gateway.open({
      snapshot: inventory(reg),
      context: rootContext(),
      limits: { maxCalls: 16, maxConcurrency: 4 },
    })
    const all = Effect.all(
      Array.from({ length: 8 }, (_, index) =>
        run.invoke({ ref: reg.identity.ref, args: { index } }),
      ),
      { concurrency: "unbounded" },
    )
    const fiber = yield* all.pipe(Effect.forkScoped({ startImmediately: true }))

    yield* awaitWithTimeout(Deferred.await(fourStarted), "four leaves should overlap", "2 seconds")
    expect(maximum).toBe(4)
    expect(started).toBe(4)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)
    expect(maximum).toBe(4)
    expect(started).toBe(8)
  }),
)

// ---------------------------------------------------------------------------
// Per-frame interrupt lifecycle
// ---------------------------------------------------------------------------

it.effect("gives each leaf an independently cancellable abort linked to the root abort", () =>
  Effect.gen(function* () {
    const rootController = new AbortController()
    const reg = registration({ semantic: leaf(0) })
    const root = rootContext({ abort: rootController.signal })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root })

    yield* run.invoke({ ref: reg.identity.ref, args: { index: 0 } })

    const leafAbort = probe.leaves[0]!.abort
    expect(leafAbort).not.toBe(root.abort)
    expect(leafAbort.aborted).toBe(false)
    expect(probe.leaves[0]?.hasSemanticAsk).toBe(true)

    rootController.abort()
    expect(leafAbort.aborted).toBe(true)
  }),
)

it.effect("cancels only the targeted leaf frame and leaves its sibling successful", () =>
  Effect.gen(function* () {
    const interrupts = yield* ToolInterrupt.Service
    const started = yield* Deferred.make<void>()
    const siblingDone = yield* Deferred.make<void>()
    const reg = registration({
      semantic: (args, ctx) => {
        if ((args as { mode?: string }).mode === "block") {
          return Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* waitForAbort(ctx.abort)
          })
        }
        return Effect.gen(function* () {
          yield* Deferred.succeed(siblingDone, undefined)
          return { title: "sibling", metadata: {}, output: "sibling" }
        })
      },
    })
    const root = rootContext()
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root })

    const blocked = yield* Effect.forkScoped(run.invoke({ ref: reg.identity.ref, args: { mode: "block" } }), {
      startImmediately: true,
    })
    yield* Deferred.await(started)
    const blockedFrame = probe.tracked[0]!.callID

    const sibling = yield* Effect.forkScoped(run.invoke({ ref: reg.identity.ref, args: { mode: "finish" } }), {
      startImmediately: true,
    })
    yield* Deferred.await(siblingDone)
    expect(Exit.isSuccess(yield* Fiber.await(sibling))).toBe(true)

    expect(yield* interrupts.kill({ sessionID: root.sessionID, callID: blockedFrame })).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(blocked))).toBe(true)

    expect(probe.killed).toEqual([{ sessionID: root.sessionID, callID: blockedFrame }])

    const trace = yield* run.trace()
    expect(trace.frames.find((frame) => frame.frameID === blockedFrame)?.status).toBe("cancelled")
    expect(trace.frames.find((frame) => frame.frameID !== blockedFrame)?.status).toBe("succeeded")

    // One interrupt entry per frame, each released exactly once.
    const trackedIDs = probe.tracked.map((entry) => entry.callID)
    expect(new Set(trackedIDs).size).toBe(2)
    expect(probe.released.map((entry) => entry.callID).sort()).toEqual([...trackedIDs].sort())
    expect(probe.released).toHaveLength(2)
  }),
)

it.effect("marks a root-aborted leaf as cancelled and still releases its interrupt entry", () =>
  Effect.gen(function* () {
    const rootController = new AbortController()
    const started = yield* Deferred.make<void>()
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* waitForAbort(ctx.abort)
        }),
    })
    const root = rootContext({ abort: rootController.signal })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root })

    const fiber = yield* Effect.forkScoped(run.invoke({ ref: reg.identity.ref, args: {} }), {
      startImmediately: true,
    })
    yield* Deferred.await(started)
    rootController.abort()

    expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)

    const frame = (yield* run.trace()).frames[0]
    expect(frame?.status).toBe("cancelled")
    expect(frame?.attachmentCount).toBeUndefined()
    expect(probe.released).toHaveLength(1)
    expect(probe.released[0]?.callID).toBe(frame?.frameID)
    expect(interruptEntries.size).toBe(0)
  }),
)

it.effect("aborts an in-flight leaf permission ask when the root is cancelled", () =>
  Effect.gen(function* () {
    const rootController = new AbortController()
    probe.askReached = yield* Deferred.make<void>()
    const reg = registration({
      semantic: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.semanticAsk!({ ...ASK_INPUT, metadata: {} })
          return { title: "unreachable", metadata: {}, output: "unreachable" }
        }),
    })
    const root = rootContext({ abort: rootController.signal })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: root, executionID: "exec-1" })

    const fiber = yield* Effect.forkScoped(run.invoke({ ref: reg.identity.ref, args: {} }), {
      startImmediately: true,
    })
    yield* Deferred.await(probe.askReached!)
    const frameID = probe.tracked[0]?.callID
    expect(frameID).toBeDefined()
    const tracked = frameID ? interruptEntries.get(interruptKey(root.sessionID, frameID)) : undefined
    expect(tracked).toBeDefined()
    rootController.abort()
    expect(tracked?.signal.aborted).toBe(true)

    const exit = yield* Fiber.await(fiber)
    expect(probe.order).toContain("ask:finalized")
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    // The pending ask is cut by the frame abort, not by a permission reply.
    expect(Cause.hasDies(exit.cause)).toBe(true)
    const defect = Cause.squash(exit.cause)
    expect(defect).toBeInstanceOf(DOMException)
    expect((defect as DOMException).name).toBe("AbortError")
    expect(probe.released).toHaveLength(1)
  }),
)

it.effect("releases the interrupt entry even when the leaf fails outright", () =>
  Effect.gen(function* () {
    const reg = registration({ semantic: () => Effect.fail(new Error("leaf refused")) })
    const run = yield* Gateway.open({ snapshot: inventory(reg), context: rootContext() })

    yield* Effect.flip(run.invoke({ ref: reg.identity.ref, args: {} }))

    expect(probe.released).toEqual(probe.tracked)
    expect(interruptEntries.size).toBe(0)
  }),
)
