import { Effect, Exit, Ref, Schema, Semaphore } from "effect"
import type { Agent } from "@/agent/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { Snapshot as WorkspaceSnapshot } from "@/snapshot"
import * as Capability from "@/tool/capability"
import { ToolInterrupt } from "@/tool/interrupt"
import type * as Tool from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { CAPABILITY_INVOCATION_LIMITS } from "./capability-invocation-limits"

export const DEFAULT_LIMITS = CAPABILITY_INVOCATION_LIMITS

export type Limits = {
  readonly maxCalls: number
  readonly maxDepth: number
  readonly maxConcurrency: number
  readonly maxTraceFrames: number
  readonly maxTraceMetadataBytes: number
}

export class UnknownCapabilityError extends Schema.TaggedErrorClass<UnknownCapabilityError>()(
  "CapabilityUnknownError",
  { ref: Schema.String },
) {
  override get message() {
    return `Unknown capability ref: ${this.ref}`
  }
}

export class CapabilityNotCallableError extends Schema.TaggedErrorClass<CapabilityNotCallableError>()(
  "CapabilityNotCallableError",
  {
    ref: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.detail
      ? `Capability ${this.ref} is not callable from Code: ${this.detail}`
      : `Capability ${this.ref} is not callable from Code`
  }
}

export class CapabilityCallLimitError extends Schema.TaggedErrorClass<CapabilityCallLimitError>()(
  "CapabilityCallLimitError",
  { limit: Schema.Number },
) {
  override get message() {
    return `Capability call limit exceeded (${this.limit})`
  }
}

export class CapabilityDepthLimitError extends Schema.TaggedErrorClass<CapabilityDepthLimitError>()(
  "CapabilityDepthLimitError",
  {
    depth: Schema.Number,
    limit: Schema.Number,
  },
) {
  override get message() {
    return `Capability nesting depth ${this.depth} exceeds limit ${this.limit}`
  }
}

export class CapabilityCycleError extends Schema.TaggedErrorClass<CapabilityCycleError>()(
  "CapabilityCycleError",
  {
    ref: Schema.String,
    ancestry: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Saved capability cycle detected: ${[...this.ancestry, this.ref].join(" -> ")}`
  }
}

export type FrameStatus = "running" | "succeeded" | "failed" | "cancelled"

export type Frame = {
  readonly frameID: string
  readonly parentFrameID?: string
  readonly ref: string
  readonly kind: Capability.Kind
  readonly depth: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly durationMs?: number
  readonly status: FrameStatus
  readonly title?: string
  readonly metadata?: Record<string, unknown>
  readonly attachmentCount?: number
}

export type Trace = {
  readonly totalCalls: number
  readonly failedCalls: number
  readonly activeCalls: number
  readonly frames: readonly Frame[]
  readonly truncated: boolean
}

export type CapabilitySnapshot = {
  readonly generation: string
  readonly entries: readonly Capability.Registration[]
  readonly byRef: ReadonlyMap<string, Capability.Registration>
}

export type CaptureInput = {
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
}

export type RootInput = {
  readonly snapshot: CapabilitySnapshot
  readonly context: Tool.Context
  readonly caller?: "code" | "broker"
  readonly executionID?: string
  readonly limits?: Partial<Limits>
  readonly onProgress?: (progress: Progress) => Effect.Effect<void>
}

export type Progress = {
  readonly totalCalls: number
  readonly failedCalls: number
  readonly activeCalls: number
  readonly frame: Frame
  readonly truncated: boolean
}

export type InvokeInput = {
  readonly ref: string
  readonly args: unknown
  readonly parentFrameID?: string
  readonly depth?: number
  /** Internal immutable ancestry used for saved-capability cycle detection. */
  readonly ancestry?: readonly string[]
}

export interface Run {
  readonly snapshot: CapabilitySnapshot
  readonly invoke: (input: InvokeInput) => Effect.Effect<Tool.ExecuteResult, unknown>
  readonly trace: () => Effect.Effect<Trace>
}

type MutableTrace = {
  nextFrame: number
  totalCalls: number
  failedCalls: number
  activeCalls: number
  frames: Frame[]
  truncated: boolean
}

function positive(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function limits(input: Partial<Limits> | undefined): Limits {
  return {
    maxCalls: positive(input?.maxCalls, DEFAULT_LIMITS.maxCalls),
    maxDepth: positive(input?.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxConcurrency: positive(input?.maxConcurrency, DEFAULT_LIMITS.maxConcurrency),
    maxTraceFrames: positive(input?.maxTraceFrames, DEFAULT_LIMITS.maxTraceFrames),
    maxTraceMetadataBytes: positive(input?.maxTraceMetadataBytes, DEFAULT_LIMITS.maxTraceMetadataBytes),
  }
}

function hookToolID(registration: Capability.Registration) {
  switch (registration.kind) {
    case "native":
    case "lazy":
    case "mcp-resource":
      return registration.identity.segments[0] ?? registration.identity.ref
    case "mcp":
      return registration.permissionKey ?? registration.identity.ref
    case "saved":
      return registration.identity.ref
  }
}

function boundMetadata(value: Record<string, unknown> | undefined, maxBytes: number) {
  if (!value) return undefined
  try {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json, "utf8") <= maxBytes) return JSON.parse(json) as Record<string, unknown>
    const preview = Buffer.from(json)
      .subarray(0, Math.max(0, maxBytes - 64))
      .toString("utf8")
    return { truncated: true, preview }
  } catch {
    return { unserializable: true }
  }
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<never> {
  return Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.die(new DOMException("Capability invocation aborted", "AbortError")))
      return
    }
    const onAbort = () => resume(Effect.die(new DOMException("Capability invocation aborted", "AbortError")))
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

export function fromInventory(inventory: Capability.Inventory): CapabilitySnapshot {
  const byRef = new Map<string, Capability.Registration>()
  for (const entry of inventory.entries) {
    if (byRef.has(entry.identity.ref)) {
      throw new Error(`Duplicate capability ref in inventory snapshot: ${entry.identity.ref}`)
    }
    byRef.set(entry.identity.ref, entry)
  }
  return Object.freeze({
    generation: inventory.generation,
    entries: Object.freeze([...inventory.entries]),
    byRef,
  })
}

export const capture = Effect.fn("CapabilityInvocationGateway.capture")(function* (input: CaptureInput) {
  const registry = yield* ToolRegistry.Service
  return fromInventory(yield* registry.capabilities(input))
})

export type HostServices = {
  readonly plugin: Plugin.Interface
  readonly permission: Permission.Interface
  readonly workspace: WorkspaceSnapshot.Interface
  readonly interrupt: ToolInterrupt.Interface
}

export const openWithServices = Effect.fn("CapabilityInvocationGateway.openWithServices")(function* (
  input: RootInput,
  services: HostServices,
) {
  const { plugin, permission, workspace, interrupt } = services
  const configured = limits(input.limits)
  const permits = yield* Semaphore.make(configured.maxConcurrency)
  const traceState = yield* Ref.make<MutableTrace>({
    nextFrame: 0,
    totalCalls: 0,
    failedCalls: 0,
    activeCalls: 0,
    frames: [],
    truncated: false,
  })

  const updateFrame = (frameID: string, update: (frame: Frame) => Frame) =>
    Ref.update(traceState, (state) => ({
      ...state,
      frames: state.frames.map((frame) => (frame.frameID === frameID ? update(frame) : frame)),
    }))

  type Allocation =
    | CapabilityCallLimitError
    | { readonly frameID: string; readonly depth: number; readonly progress: Progress }

  const publishProgress = (progress: Progress) =>
    input.onProgress ? input.onProgress(progress).pipe(Effect.catchCause(() => Effect.void)) : Effect.void

  const allocate = Effect.fn("CapabilityInvocationGateway.allocate")(function* (
    registration: Capability.Registration,
    invocation: InvokeInput,
  ) {
    const depth = invocation.depth ?? 0
    if (depth > configured.maxDepth) {
      return yield* new CapabilityDepthLimitError({ depth, limit: configured.maxDepth })
    }
    return yield* Ref.modify(traceState, (state): readonly [Allocation, MutableTrace] => {
      if (state.totalCalls >= configured.maxCalls) {
        return [new CapabilityCallLimitError({ limit: configured.maxCalls }), state]
      }
      const next = state.nextFrame + 1
      const frameID = `${input.context.callID ?? input.context.partID ?? "code"}#${next}`
      const frame: Frame = {
        frameID,
        ...(invocation.parentFrameID ? { parentFrameID: invocation.parentFrameID } : {}),
        ref: registration.identity.ref,
        kind: registration.kind,
        depth,
        startedAt: Date.now(),
        status: "running",
      }
      const frames = state.frames.length < configured.maxTraceFrames ? [...state.frames, frame] : state.frames
      const nextState: MutableTrace = {
        nextFrame: next,
        totalCalls: state.totalCalls + 1,
        failedCalls: state.failedCalls,
        activeCalls: state.activeCalls + 1,
        frames,
        truncated: state.truncated || frames === state.frames,
      }
      return [
        {
          frameID,
          depth,
          progress: {
            totalCalls: nextState.totalCalls,
            failedCalls: nextState.failedCalls,
            activeCalls: nextState.activeCalls,
            frame,
            truncated: nextState.truncated,
          },
        },
        nextState,
      ]
    })
  })

  const invoke = Effect.fn("CapabilityInvocationGateway.invoke")(function* (invocation: InvokeInput) {
    const registration = input.snapshot.byRef.get(invocation.ref)
    if (!registration) return yield* new UnknownCapabilityError({ ref: invocation.ref })
    if (registration.kind === "saved" && invocation.ancestry?.includes(registration.identity.ref)) {
      return yield* new CapabilityCycleError({
        ref: registration.identity.ref,
        ancestry: [...invocation.ancestry],
      })
    }
    if ((input.caller ?? "code") === "code" && !registration.codeCallable) {
      const detail = registration.diagnostic
        ? `${registration.diagnostic.kind}: ${registration.diagnostic.message}`
        : undefined
      return yield* new CapabilityNotCallableError({
        ref: invocation.ref,
        ...(detail ? { detail } : {}),
      })
    }

    const execute = Effect.gen(function* () {
      const allocated = yield* allocate(registration, invocation)
      if (allocated instanceof CapabilityCallLimitError) return yield* allocated
      const { frameID, depth } = allocated
      yield* publishProgress(allocated.progress)
      const hookID = hookToolID(registration)
      const authority: Capability.InvocationAuthority = {
        ruleset: input.context.permissionRuleset ?? [],
        ...(input.executionID ? { executionID: input.executionID } : {}),
      }

      const childAbort = yield* interrupt.track({
        sessionID: input.context.sessionID,
        callID: frameID,
        parent: input.context.abort,
      })

      const leafContext: Tool.Context = {
        ...input.context,
        abort: childAbort,
        // Keep the real provider/root call identity for permission and question UI.
        callID: input.context.callID,
        partID: input.context.partID,
        metadata: (value) =>
          updateFrame(frameID, (frame) => ({
            ...frame,
            ...(value.title ? { title: value.title.slice(0, 256) } : {}),
            ...(value.metadata
              ? { metadata: boundMetadata(value.metadata as Record<string, unknown>, configured.maxTraceMetadataBytes) }
              : {}),
          })),
        ask: (request) => {
          const wait = permission.ask({
            ...request,
            sessionID: input.context.sessionID,
            ...(input.executionID && request.executionID === undefined ? { executionID: input.executionID } : {}),
            ...(input.context.callID
              ? { tool: { messageID: input.context.messageID, callID: input.context.callID } }
              : {}),
            ruleset: input.context.permissionRuleset ?? [],
          })
          // Resource/custom semantic registrations may still call ctx.ask
          // directly. Preserve Permission failures at runtime without widening the
          // provider-facing Context ABI.
          return wait.pipe(Effect.raceFirst(abortSignalEffect(childAbort))) as Effect.Effect<void>
        },
        semanticAsk: (request) =>
          permission
            .ask({
              ...request,
              sessionID: input.context.sessionID,
              ...(input.executionID && request.executionID === undefined ? { executionID: input.executionID } : {}),
              ...(input.context.callID
                ? { tool: { messageID: input.context.messageID, callID: input.context.callID } }
                : {}),
              ruleset: input.context.permissionRuleset ?? [],
            })
            .pipe(Effect.raceFirst(abortSignalEffect(childAbort))),
        // Delegators (notably saved Code programs) recurse through the same
        // root gateway so descendants inherit the frozen capability snapshot,
        // call/depth/concurrency budgets, trace, permission execution scope,
        // cancellation tree, and mutation owner. Opening another gateway here
        // would silently reset those invariants.
        invokeCapability: (ref, args) =>
          invoke({
            ref,
            args,
            parentFrameID: frameID,
            depth: depth + 1,
            ancestry: [...(invocation.ancestry ?? []), registration.identity.ref],
          }),
      }

      const semantic = Effect.gen(function* () {
        yield* plugin.trigger(
          "tool.execute.before",
          { tool: hookID, sessionID: leafContext.sessionID, callID: leafContext.callID },
          { args: invocation.args },
        )
        const result = yield* registration.invokeSemantic(invocation.args, leafContext)
        return yield* plugin.trigger(
          "tool.execute.after",
          { tool: hookID, sessionID: leafContext.sessionID, callID: leafContext.callID, args: invocation.args },
          result,
        )
      }).pipe(
        Effect.withSpan("CapabilityInvocationGateway.invoke", {
          attributes: {
            "capability.ref": registration.identity.ref,
            "capability.kind": registration.kind,
            "capability.frame_id": frameID,
            "capability.depth": depth,
            "session.id": leafContext.sessionID,
            "message.id": leafContext.messageID,
            ...(leafContext.callID ? { "tool.call_id": leafContext.callID } : {}),
          },
        }),
      )

      const admitted = registration.authorize({ authority, args: invocation.args, context: leafContext }).pipe(
        Effect.andThen(
          registration.classifyWorkspaceMutation(invocation.args)
            ? Effect.gen(function* () {
                if (leafContext.markWorkspaceMutation) yield* leafContext.markWorkspaceMutation()
                return yield* workspace.withMutation(semantic, `capability:${registration.identity.ref}`)
              })
            : semantic,
        ),
      )

      const startedAt = Date.now()
      return yield* admitted.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const progress = yield* Ref.modify(traceState, (state): readonly [Progress, MutableTrace] => {
            const finishedAt = Date.now()
            const cancelled = childAbort.aborted && !Exit.isSuccess(exit)
            const status: FrameStatus = Exit.isSuccess(exit)
              ? "succeeded"
              : cancelled
                ? "cancelled"
                : "failed"
            const nextState: MutableTrace = {
              ...state,
              failedCalls: state.failedCalls + (status === "failed" || status === "cancelled" ? 1 : 0),
              activeCalls: Math.max(0, state.activeCalls - 1),
              frames: state.frames.map((frame) =>
                frame.frameID === frameID
                  ? {
                      ...frame,
                      finishedAt,
                      durationMs: Math.max(0, finishedAt - frame.startedAt),
                      status,
                      ...(Exit.isSuccess(exit) ? { attachmentCount: exit.value.attachments?.length ?? 0 } : {}),
                    }
                  : frame,
                ),
            }
            const frame = nextState.frames.find((candidate) => candidate.frameID === frameID) ?? {
              frameID,
              ref: registration.identity.ref,
              kind: registration.kind,
              depth,
              startedAt,
              finishedAt,
              durationMs: Math.max(0, finishedAt - startedAt),
              status,
            }
            return [
              {
                totalCalls: nextState.totalCalls,
                failedCalls: nextState.failedCalls,
                activeCalls: nextState.activeCalls,
                frame,
                truncated: nextState.truncated,
              },
              nextState,
            ]
            })
            yield* publishProgress(progress)
          }),
        ),
        Effect.ensuring(
          interrupt.release({
            sessionID: input.context.sessionID,
            callID: frameID,
          }),
        ),
        Effect.withSpan("CapabilityInvocationGateway.frame", {
          attributes: {
            "capability.frame_id": frameID,
            "capability.started_at": startedAt,
          },
        }),
      )
    })

    // Saved capabilities are composition/delegator frames. Holding a leaf
    // permit while a saved frame awaits descendants can deadlock when all
    // permits are occupied by parents. Ordinary executable leaves hold the
    // permit for their complete admitted lifecycle: allocation, authorization,
    // interrupt tracking, mutation ownership, hooks, and semantic execution.
    return yield* registration.kind === "saved" ? execute : permits.withPermits(1)(execute)
  })

  const trace = Effect.fnUntraced(function* () {
    const state = yield* Ref.get(traceState)
    return {
      totalCalls: state.totalCalls,
      failedCalls: state.failedCalls,
      activeCalls: state.activeCalls,
      frames: state.frames.map((frame) => ({ ...frame })),
      truncated: state.truncated,
    } satisfies Trace
  })

  return {
    snapshot: input.snapshot,
    invoke,
    trace,
  } satisfies Run
})

export const open = Effect.fn("CapabilityInvocationGateway.open")(function* (input: RootInput) {
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const workspace = yield* WorkspaceSnapshot.Service
  const interrupt = yield* ToolInterrupt.Service
  return yield* openWithServices(input, { plugin, permission, workspace, interrupt })
})
