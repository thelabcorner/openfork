import { Effect } from "effect"
import { Tool } from "./tool"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { ToolInterrupt } from "./interrupt"
import * as CodeSchema from "@/code/schema"
import * as CodeError from "@/code/error"
import * as CodeService from "@/code/service"
import * as CodeRun from "@/code/run"
import { Session } from "@/session/session"
import { SavedCodeCatalog, SavedStorageError } from "@/code/saved"
import * as Revision from "@/code/revision"
import * as CapabilityInvocationGateway from "@/session/capability-invocation-gateway"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const CODE_TOOL = "code"

export const DESCRIPTION =
  "Programmable OpenFork orchestration. Workflow: code.search finds refs (target=callable by default; use target=saved for reusable tools and target=runs for replayable history); code.describe returns the exact callable contract or safe replay descriptor for one exact ref; code.run executes confined JavaScript/TypeScript where external work happens only through await call(ref, input); code.save promotes a successful run into a reusable versioned tool; code.call invokes a saved tool. Prefer direct tools for one simple known operation. For unfamiliar capabilities, search then describe instead of guessing arguments. Use code.run for predictable branching, loops, filtering, aggregation, or fan-out; start independent calls together and await them with Promise.all. Keep intermediate data inside code when the model does not need to inspect it. If an action returns ok:false, read and follow error.recovery before retrying or changing strategy. The runtime has no ambient filesystem, process, network, imports, credentials, or warm state; all authority comes from host capabilities and their normal permissions."

type Metadata = {
  readonly action: CodeSchema.Action
  readonly runID?: string
  readonly sourceHash?: string
  readonly replayOf?: string
  readonly sourceRunID?: string
  readonly inputRunID?: string
  readonly dependencies?: {
    readonly literalRefs: readonly string[]
    readonly dynamicCallTarget: boolean
  }
  readonly dependencyContracts?: readonly {
    readonly ref: string
    readonly executionContract: string
    readonly authorityBinding: string
    readonly pinnedHandle?: string
  }[]
  readonly calls?: { readonly total: number; readonly failed: number }
  readonly trace?: SessionV1.CodeRunTrace
  readonly saved?: {
    readonly id: string
    readonly revision: string
    readonly handle: string
    readonly path: string
  }
  readonly error?: boolean
}

const output = (value: unknown) => JSON.stringify(value)

const savedProjection = (item: {
  readonly id: string
  readonly revision: string
  readonly handle: string
  readonly root: string
}) => ({
  id: item.id,
  revision: item.revision,
  handle: item.handle,
  path: item.root,
})

function detail(cause: unknown, operation: "save" | "call"): CodeError.Detail {
  if (cause instanceof CodeRun.ResolutionError) {
    return { kind: cause.kind, message: cause.message, recovery: cause.recovery }
  }
  if (cause instanceof SavedStorageError) {
    return {
      kind: cause.kind,
      message: cause.message,
      recovery:
        cause.kind === "SavedToolAmbiguous"
          ? "Use project/<id>, global/<id>, or an immutable saved:... revision handle."
          : cause.kind === "SavedToolNotFound"
            ? "Use code.search with target=saved to discover an available saved tool."
            : cause.kind === "SavedToolDirty"
              ? "Re-save or explicitly re-admit the intended immutable saved revision before calling it."
              : "Fix the saved-tool specification or source and retry the save.",
    }
  }
  if (cause instanceof Revision.SavedRevisionError) {
    return {
      kind: "SaveRejected",
      message: cause.message,
      recovery: "Rerun under the current capability contracts, then save with static dependencies and valid schemas.",
    }
  }
  if (cause instanceof CapabilityInvocationGateway.CapabilityCycleError) {
    return {
      kind: "SavedToolCycle",
      message: cause.message,
      recovery: "Remove the recursive saved-tool dependency or add a non-recursive base case outside the saved call graph.",
    }
  }
  if (cause instanceof CapabilityInvocationGateway.CapabilityDepthLimitError) {
    return {
      kind: "SavedToolDepthExceeded",
      message: cause.message,
      recovery: "Flatten the saved-tool composition graph or reduce nested saved calls.",
    }
  }
  if (cause instanceof CapabilityInvocationGateway.CapabilityNotCallableError) {
    return {
      kind: "DependencyContractChanged",
      message: cause.message,
      recovery: "Inspect the saved tool with code.describe and re-save it against the current dependency contracts.",
    }
  }
  if (cause instanceof PermissionV1.DeniedError) {
    return {
      kind: "CapabilityDenied",
      message: "The Code operation was denied by the active permission policy.",
      recovery: "Use an allowed saved tool/scope or change the relevant code permission policy.",
    }
  }
  return {
    kind: operation === "save" ? "SaveRejected" : "CapabilityFailed",
    message: cause instanceof Error ? cause.message : String(cause),
    recovery:
      operation === "save"
        ? "Inspect the source run and save specification, then retry."
        : "Inspect the exact saved-tool contract with code.describe, revise the input or dependency state, then retry.",
  }
}

export const CodeTool = Tool.define(
  CODE_TOOL,
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const snapshot = yield* Snapshot.Service
    const interrupt = yield* ToolInterrupt.Service
    const session = yield* Session.Service
    const savedCatalog = yield* SavedCodeCatalog.Service

    const scopeContext = Effect.fn("Code.scopeContext")(function* (ctx: Tool.Context) {
      const physical = yield* session.physicalScope(ctx.sessionID)
      return {
        project: {
          root: physical.root,
          key: physical.key,
        },
      }
    })

    const promote = Effect.fn("Code.promote")(function* (
      material: {
        readonly code: string
        readonly runID: string
        readonly sourceHash: string
        readonly sessionID: Tool.Context["sessionID"]
        readonly messageID: Tool.Context["messageID"]
        readonly dependencies: readonly Revision.Dependency[]
      },
      spec: CodeSchema.SaveSpec,
      inventory: import("@/tool/capability").Inventory,
      ctx: Tool.Context,
    ) {
      const scope = spec.scope ?? "project"
      Revision.preflightDependencies({
        dependencies: material.dependencies,
        inventory,
        scope,
      })
      const derived = Revision.derive({
        source: material.code,
        spec,
        dependencies: material.dependencies,
      })
      if (derived.sourceHash !== material.sourceHash) {
        return yield* Effect.fail(
          new Revision.SavedRevisionError("The save source hash changed after CodeRun verification."),
        )
      }
      const manifest = Revision.manifest({
        derived,
        spec,
        origin: {
          run: material.runID,
          session: material.sessionID,
          message: material.messageID,
        },
      })
      const pattern = `save:${scope}:${manifest.id}`
      const executionID = `code:${ctx.partID ?? ctx.callID ?? ctx.messageID}`
      const save = Effect.gen(function* () {
        yield* permission.ask({
          permission: "code",
          patterns: [pattern],
          always: [pattern],
          metadata: { action: "save", scope, id: manifest.id, revision: manifest.revision },
          sessionID: ctx.sessionID,
          ...(ctx.callID ? { tool: { messageID: ctx.messageID, callID: ctx.callID } } : {}),
          ruleset: ctx.permissionRuleset ?? [],
          executionID,
        })
        return yield* savedCatalog.save({
          context: yield* scopeContext(ctx),
          scope,
          manifest,
          source: derived.source,
        })
      })
      return yield* save.pipe(
        Effect.ensuring(permission.releaseExecution({ sessionID: ctx.sessionID, executionID })),
      )
    })

    const init: Tool.DefWithoutID<typeof CodeSchema.Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: CodeSchema.Parameters,
      execute: Effect.fn("Code.execute")(function* (raw, ctx) {
        let params: CodeSchema.Parameters
        try {
          params = CodeSchema.validate(raw)
        } catch (cause) {
          const envelope = CodeError.invalidInput(
            CodeService.runID(ctx),
            cause instanceof Error ? cause.message : "Invalid code request.",
          )
          return {
            title: CODE_TOOL,
            metadata: { action: raw.action, error: true },
            output: output(envelope),
            data: envelope,
          } satisfies Tool.ExecuteResult<Metadata>
        }

        if (!ctx.captureCapabilities) {
          const envelope = CodeError.invalidInput(
            CodeService.runID(ctx),
            "Code requires a host capability snapshot.",
          )
          return {
            title: CODE_TOOL,
            metadata: { action: params.action, error: true },
            output: output(envelope),
            data: envelope,
          } satisfies Tool.ExecuteResult<Metadata>
        }

        const inventory = yield* ctx.captureCapabilities()

        if (params.action === "search") {
          if ((params.target ?? "callable") === "runs") {
            const attempted = yield* session
              .searchCodeRuns({
                sessionID: ctx.sessionID,
                query: params.query,
                limit: params.limit,
                cursor: params.cursor,
              })
              .pipe(
                Effect.map((value) => ({ ok: true as const, value })),
                Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
              )
            if (attempted.ok) {
              return {
                title: CODE_TOOL,
                metadata: { action: params.action },
                output: output(attempted.value),
                data: attempted.value,
              } satisfies Tool.ExecuteResult<Metadata>
            }
            const envelope = CodeError.invalidInput(
              CodeService.runID(ctx),
              attempted.cause instanceof Error ? attempted.cause.message : "Invalid Code run search request.",
            )
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, error: true },
              output: output(envelope),
              data: envelope,
            } satisfies Tool.ExecuteResult<Metadata>
          }
          try {
            const result = CodeService.search(inventory, params)
            return {
              title: CODE_TOOL,
              metadata: { action: params.action },
              output: output(result),
              data: result,
            } satisfies Tool.ExecuteResult<Metadata>
          } catch (cause) {
            const envelope = CodeError.invalidInput(
              CodeService.runID(ctx),
              cause instanceof Error ? cause.message : "Invalid code.search request.",
            )
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, error: true },
              output: output(envelope),
              data: envelope,
            } satisfies Tool.ExecuteResult<Metadata>
          }
        }

        if (params.action === "save") {
          const attempted = yield* Effect.gen(function* () {
            const source = yield* CodeRun.resolveSaveSource({
              store: session,
              currentSessionID: ctx.sessionID,
              requestedRunID: params.runID!,
            })
            const saved = yield* promote(source, params.save!, inventory, ctx)
            return { source, saved }
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!attempted.ok) {
            const failure = CodeError.failure(
              params.runID!,
              detail(attempted.cause, "save").kind,
              detail(attempted.cause, "save").message,
              detail(attempted.cause, "save").recovery,
            )
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, runID: params.runID, error: true },
              output: output(failure),
              data: failure,
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const saved = savedProjection(attempted.value.saved)
          const response = {
            ok: true as const,
            runID: attempted.value.source.runID,
            sourceHash: attempted.value.source.sourceHash,
            saved,
          }
          return {
            title: CODE_TOOL,
            metadata: {
              action: params.action,
              runID: response.runID,
              sourceHash: response.sourceHash,
              saved,
            },
            output: output(response),
            data: response,
          } satisfies Tool.ExecuteResult<Metadata>
        }

        if (params.action === "call") {
          const attempted = yield* Effect.gen(function* () {
            const item = yield* savedCatalog.resolve(yield* scopeContext(ctx), params.tool!)
            const called = yield* CodeService.callCapability({
              ref: item.handle,
              value: params.input ?? {},
              ctx,
              inventory,
              services: { permission, plugin, snapshot, interrupt },
            })
            return { item, called }
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!attempted.ok) {
            const wrapped =
              attempted.cause instanceof CodeService.CapabilityCallFailure ? attempted.cause : undefined
            const mapped = detail(wrapped?.semanticCause ?? attempted.cause, "call")
            const failure = CodeError.failure(
              CodeService.runID(ctx),
              mapped.kind,
              mapped.message,
              mapped.recovery,
              wrapped ? { calls: wrapped.calls } : undefined,
            )
            return {
              title: CODE_TOOL,
              metadata: {
                action: params.action,
                runID: failure.runID,
                ...(wrapped ? { calls: wrapped.calls, trace: wrapped.trace } : {}),
                error: true,
              },
              output: output(failure),
              data: failure,
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const { item, called } = attempted.value
          const saved = savedProjection(item)
          const value = called.result.data !== undefined ? called.result.data : called.result.output
          const response: CodeError.Success = {
            ok: true,
            runID: CodeService.runID(ctx),
            sourceHash: item.envelope.sourceHash,
            replayable: false,
            value,
            calls: called.calls,
            saved,
          }
          return {
            title: CODE_TOOL,
            metadata: {
              action: params.action,
              runID: response.runID,
              sourceHash: response.sourceHash,
              calls: response.calls,
              trace: called.trace,
              saved,
            },
            output: output(response),
            data: response,
            ...(called.result.attachments?.length ? { attachments: called.result.attachments } : {}),
          } satisfies Tool.ExecuteResult<Metadata>
        }

        if (params.action === "describe") {
          if (params.ref!.startsWith("run:")) {
            const attempted = yield* CodeRun.describeRun({
              store: session,
              currentSessionID: ctx.sessionID,
              runID: params.ref!,
            }).pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
            )
            if (attempted.ok) {
              return {
                title: CODE_TOOL,
                metadata: { action: params.action },
                output: output(attempted.value),
                data: attempted.value,
              } satisfies Tool.ExecuteResult<Metadata>
            }
            const cause = attempted.cause
            const envelope = CodeError.failure(
              CodeService.runID(ctx),
              cause.kind,
              cause.message,
              cause.recovery,
            )
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, error: true },
              output: output(envelope),
              data: envelope,
            } satisfies Tool.ExecuteResult<Metadata>
          }
          try {
            const result = CodeService.describe(inventory, params.ref!)
            return {
              title: CODE_TOOL,
              metadata: { action: params.action },
              output: output(result),
              data: result,
            } satisfies Tool.ExecuteResult<Metadata>
          } catch (cause) {
            const envelope = CodeError.invalidInput(
              CodeService.runID(ctx),
              cause instanceof Error ? cause.message : "Invalid code.describe request.",
            )
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, error: true },
              output: output(envelope),
              data: envelope,
            } satisfies Tool.ExecuteResult<Metadata>
          }
        }

        let code = params.code
        let value: unknown = params.input ?? {}
        let replay:
          | {
              readonly replayOf: string
              readonly sourceRunID: string
              readonly inputRunID: string
            }
          | undefined

        if (params.runID !== undefined) {
          const resolved = yield* CodeRun.resolveReplay({
            store: session,
            currentSessionID: ctx.sessionID,
            requestedRunID: params.runID,
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          )
          if (!resolved.ok) {
            const failure = resolved.error
            const envelope: CodeError.Failure = {
              ok: false,
              runID: CodeService.runID(ctx),
              replayOf: params.runID,
              error: {
                kind: failure.kind,
                message: failure.message,
                recovery: failure.recovery,
              },
            }
            return {
              title: CODE_TOOL,
              metadata: { action: params.action, runID: envelope.runID, replayOf: params.runID, error: true },
              output: output(envelope),
              data: envelope,
            } satisfies Tool.ExecuteResult<Metadata>
          }

          const currentRunID = CodeService.runID(ctx)
          const override = params.input !== undefined
          code = resolved.value.code
          value = override ? params.input : resolved.value.value
          replay = {
            replayOf: resolved.value.replayOf,
            sourceRunID: resolved.value.sourceRunID,
            inputRunID: override ? currentRunID : resolved.value.inputRunID,
          }
        }

        const result = yield* CodeService.runInline({
          code: code!,
          value,
          ctx,
          inventory,
          services: { permission, plugin, snapshot, interrupt },
          ...(replay ? { replay } : {}),
        })

        let envelope = result.envelope
        let saved:
          | {
              readonly id: string
              readonly revision: string
              readonly handle: string
              readonly path: string
            }
          | undefined
        const saveSpec = params.save
        if (saveSpec && envelope.ok) {
          const successful = envelope
          const attempted = yield* Effect.gen(function* () {
            if (result.dependencies.dynamicCallTarget) {
              return yield* Effect.fail(
                new Revision.SavedRevisionError(
                  "Saved tools require static call(ref, input) targets; this run used a computed capability ref.",
                ),
              )
            }
            if (!result.dependencyContracts) {
              return yield* Effect.fail(
                new Revision.SavedRevisionError(
                  "The successful run could not capture every static dependency contract and cannot be promoted.",
                ),
              )
            }
            return yield* promote(
              {
                code: Revision.canonicalSource(code!),
                runID: successful.runID,
                sourceHash: successful.sourceHash,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                dependencies: result.dependencyContracts,
              },
              saveSpec,
              inventory,
              ctx,
            )
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!attempted.ok) {
            const mapped = detail(attempted.cause, "save")
            envelope = CodeError.failure(
              successful.runID,
              mapped.kind,
              mapped.message,
              mapped.recovery,
              {
                sourceHash: successful.sourceHash,
                sourceRunID: successful.sourceRunID,
                calls: successful.calls,
              },
            )
          } else {
            saved = savedProjection(attempted.value)
            envelope = { ...envelope, saved }
          }
        }

        return {
          title: CODE_TOOL,
          metadata: {
            action: params.action,
            runID: envelope.runID,
            sourceHash: envelope.sourceHash,
            ...result.lineage,
            dependencies: result.dependencies,
            ...(result.dependencyContracts ? { dependencyContracts: result.dependencyContracts } : {}),
            calls: envelope.calls,
            trace: result.trace,
            ...(saved ? { saved } : {}),
            ...(!envelope.ok ? { error: true } : {}),
          },
          output: output(envelope),
          data: envelope,
          ...(result.attachments.length > 0 ? { attachments: result.attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }),
    }
    return init
  }),
)
