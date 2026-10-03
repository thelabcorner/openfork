import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeEdit } from "@/exchange/edit"
import { ExchangeError } from "@/exchange/error"
import { ExchangeWrite } from "@/exchange/write"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonEmptyText = Schema.String.check(Schema.isMinLength(1))

const BatchOp = Schema.Union([
  Schema.Struct({
    line: PositiveInt,
    newText: Schema.String,
    oldText: NonEmptyText,
  }),
  Schema.Struct({
    startLine: PositiveInt,
    endLine: PositiveInt,
    newText: Schema.String,
    oldText: NonEmptyText,
  }),
  Schema.Struct({
    startLine: PositiveInt,
    endLine: PositiveInt,
    oldText: NonEmptyText,
    delete: Schema.Literal(true),
  }),
  Schema.Struct({
    oldString: NonEmptyText,
    newString: Schema.String,
  }),
])

const Target = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "Text-file target. Surgical edit strategies modify existing text; content creates or fully replaces through atomic write semantics.",
  }),
  rootID: Schema.optionalKey(OxpSchema.RootID),
})

function recoverableMissingContent(input: RuntimeInput) {
  if ("oldString" in input && input.oldString === "") {
    return { content: input.newString, reason: "empty oldString creation intent" }
  }
  if ("appendFile" in input && input.appendFile === true) {
    return { content: input.newText, reason: "append-to-missing-file intent" }
  }
  if ("insertAt" in input && input.insertAt === 0 && "newText" in input) {
    return { content: input.newText, reason: "prepend-to-missing-file intent" }
  }
  return undefined
}

const ExactEdit = Schema.Struct({
  ...Target.fields,
  oldString: Schema.String,
  newString: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
})

const FullContent = Schema.Struct({
  ...Target.fields,
  content: Schema.String,
})

const BatchEdit = Schema.Struct({
  ...Target.fields,
  edits: Schema.Array(BatchOp).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})

const LineEdit = Schema.Struct({
  ...Target.fields,
  line: PositiveInt,
  oldText: NonEmptyText,
  newText: Schema.String,
})

const RangeEdit = Schema.Struct({
  ...Target.fields,
  startLine: PositiveInt,
  endLine: PositiveInt,
  oldText: NonEmptyText,
  newText: Schema.String,
})

const DeleteRange = Schema.Struct({
  ...Target.fields,
  startLine: PositiveInt,
  endLine: PositiveInt,
  oldText: NonEmptyText,
  delete: Schema.Literal(true),
})

const Prepend = Schema.Struct({
  ...Target.fields,
  insertAt: Schema.Literal(0),
  newText: Schema.String,
})

const InsertAt = Schema.Struct({
  ...Target.fields,
  insertAt: PositiveInt,
  oldText: NonEmptyText,
  newText: Schema.String,
})

const InsertAfter = Schema.Struct({
  ...Target.fields,
  insertAfter: PositiveInt,
  oldText: NonEmptyText,
  newText: Schema.String,
})

const AppendFile = Schema.Struct({
  ...Target.fields,
  appendFile: Schema.Literal(true),
  newText: Schema.String,
})

const NearTextEdit = Schema.Struct({
  ...Target.fields,
  nearText: NonEmptyText,
  occurrence: Schema.optionalKey(PositiveInt),
  oldText: NonEmptyText,
  newText: Schema.String,
})

/**
 * Runtime grammar stays strategy-shaped so mixed or underspecified mutations
 * are rejected before authority checks or filesystem work.
 */
const RuntimeParameters = Schema.Union([
  FullContent,
  ExactEdit,
  BatchEdit,
  LineEdit,
  RangeEdit,
  DeleteRange,
  Prepend,
  InsertAt,
  InsertAfter,
  AppendFile,
  NearTextEdit,
])
type RuntimeInput = Schema.Schema.Type<typeof RuntimeParameters>

/**
 * Transport-safe public envelope.
 *
 * ChatGPT/MCP host projection can collapse a root strategy union into an
 * untyped dictionary. Publish the complete field vocabulary as one typed object
 * and re-apply RuntimeParameters at execution.
 */
export const Parameters = Schema.Struct({
  ...Target.fields,
  content: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Complete desired file content. Self-healing compatibility strategy: creates a missing file or fully replaces an existing file using write semantics.",
    }),
  ),
  oldString: Schema.optionalKey(Schema.String),
  newString: Schema.optionalKey(Schema.String),
  replaceAll: Schema.optionalKey(Schema.Boolean),
  edits: Schema.optionalKey(Schema.Array(BatchOp).check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  line: Schema.optionalKey(PositiveInt),
  startLine: Schema.optionalKey(PositiveInt),
  endLine: Schema.optionalKey(PositiveInt),
  oldText: Schema.optionalKey(NonEmptyText),
  newText: Schema.optionalKey(Schema.String),
  delete: Schema.optionalKey(Schema.Literal(true)),
  insertAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  insertAfter: Schema.optionalKey(PositiveInt),
  appendFile: Schema.optionalKey(Schema.Literal(true)),
  nearText: Schema.optionalKey(NonEmptyText),
  occurrence: Schema.optionalKey(PositiveInt),
})
export type Input = Schema.Schema.Type<typeof Parameters>

const transportStrategy = (
  allowed: readonly string[],
  required: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  type: "object" as const,
  properties: Object.fromEntries(
    allowed.map((name) => [name, overrides[name] ?? {}]),
  ),
  required: [...required],
  additionalProperties: false as const,
})

/**
 * Exact strategy grammar for MCP clients that preserve conditional JSON Schema.
 * The public Effect schema remains a flat transport envelope because some
 * ChatGPT connector projections discard root unions; RuntimeParameters is still
 * the authoritative execution validator.
 */
export const TransportStrategyConstraints = Object.freeze({
  oneOf: Object.freeze([
    transportStrategy(["path", "rootID", "content"], ["path", "content"]),
    transportStrategy(["path", "rootID", "oldString", "newString", "replaceAll"], ["path", "oldString", "newString"]),
    transportStrategy(["path", "rootID", "edits"], ["path", "edits"]),
    transportStrategy(["path", "rootID", "line", "oldText", "newText"], ["path", "line", "oldText", "newText"]),
    transportStrategy(["path", "rootID", "startLine", "endLine", "oldText", "newText"], ["path", "startLine", "endLine", "oldText", "newText"]),
    transportStrategy(["path", "rootID", "startLine", "endLine", "oldText", "delete"], ["path", "startLine", "endLine", "oldText", "delete"]),
    transportStrategy(["path", "rootID", "insertAt", "newText"], ["path", "insertAt", "newText"], {
      insertAt: { const: 0 },
    }),
    transportStrategy(["path", "rootID", "insertAt", "oldText", "newText"], ["path", "insertAt", "oldText", "newText"], {
      insertAt: { type: "integer", minimum: 1 },
    }),
    transportStrategy(["path", "rootID", "insertAfter", "oldText", "newText"], ["path", "insertAfter", "oldText", "newText"]),
    transportStrategy(["path", "rootID", "appendFile", "newText"], ["path", "appendFile", "newText"], {
      appendFile: { const: true },
    }),
    transportStrategy(["path", "rootID", "nearText", "occurrence", "oldText", "newText"], ["path", "nearText", "oldText", "newText"]),
  ]),
})

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpEdit") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AmbiguousCommit) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.detail) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service

    const executeRaw = Effect.fn("OxpEdit.executeRaw")(function* (input: RuntimeInput, signal?: AbortSignal) {
      yield* OxpLocation.requireExplicit(input, "edit")
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "edit",
        phase: "mutate",
        rootID: input.rootID,
        path: input.path,
        allowMissing: true,
      })
      if (!admission.root || !("path" in admission.root)) {
        return yield* new OxpError.RootRequired({ detail: "edit requires an approved file path" })
      }
      const target = admission.root.path
      const virtualPath = admission.root.virtualPath
      const root = admission.root.root
      const principal = (yield* config.get()).connector.id
      const scopedGrounding = grounding.scoped(principal)
      const grounded = scopedGrounding.get(root.id, target)
      const revalidateTarget = () =>
        Effect.gen(function* () {
          const freshAdmission = yield* authority.revalidate(admission, "commit")
          if (!freshAdmission.root || !("path" in freshAdmission.root)) {
            return yield* new OxpError.AuthRevoked({ detail: "OXP edit authority changed before commit" })
          }
          if (FSUtil.normalizePath(freshAdmission.root.path) !== FSUtil.normalizePath(target)) {
            return yield* new OxpError.AuthRevoked({ detail: "OXP edit target identity changed before commit" })
          }
        })

      const writeThroughEdit = Effect.fn("OxpEdit.writeThroughEdit")(function* (
        content: string,
        reason: string,
      ) {
        const execution = yield* ExchangeWrite.execute(
          fs,
          {
            path: target,
            displayPath: virtualPath,
            content,
            expectedFingerprint: grounded,
            signal,
            projectionMarker:
              "<note>OXP edit self-healed through atomic write; output diff truncated, inspect the file for complete post-state</note>",
          },
          { revalidate: revalidateTarget },
        ).pipe(
          Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))),
        )
        if (execution.fingerprint) scopedGrounding.note(root.id, target, execution.fingerprint)
        return {
          ...execution.result,
          output:
            "Self-healed edit request through atomic write semantics (" + reason + ").\n\n" +
            execution.result.output,
          metadata: {
            ...execution.result.metadata,
            routedFrom: "edit",
            routedTo: "write",
            routeReason: reason,
          },
          mutation: execution.mutation,
        } satisfies OxpResult.CapabilityResult
      })

      if ("content" in input) {
        return yield* writeThroughEdit(input.content, "explicit content strategy")
      }

      const { rootID: _rootID, ...editInput } = input
      const attempted = yield* ExchangeEdit.execute(
        fs,
        {
          ...(editInput as ExchangeEdit.Input),
          canonicalPath: target,
          displayPath: virtualPath,
          ...(grounded === undefined ? {} : { groundedFingerprint: grounded }),
          ungroundedWarning:
            "This file has no OXP read-grounding record. The edit is still verified against current content, but read it first when relying on line coordinates.",
          signal,
        },
        {
          revalidate: revalidateTarget,
          beforeCommit: () => Effect.void,
        },
      ).pipe(Effect.exit)
      if (Exit.isFailure(attempted)) {
        const cause = Cause.squash(attempted.cause)
        const recovery =
          cause instanceof ExchangeError.NotFound
            ? recoverableMissingContent(input)
            : undefined
        if (recovery) {
          return yield* writeThroughEdit(recovery.content, recovery.reason)
        }
        if (cause instanceof ExchangeError.NotFound) {
          return yield* new OxpError.NotFound({
            detail:
              "Edit target does not exist: " +
              virtualPath +
              ". For a new file, retry this same edit tool with content:<complete file text>, or use write directly.",
          })
        }
        if (OxpError.isError(cause)) return yield* Effect.fail(cause)
        if (
          cause instanceof ExchangeError.InvalidArgument ||
          cause instanceof ExchangeError.Cancelled ||
          cause instanceof ExchangeError.Conflict ||
          cause instanceof ExchangeError.PathEscape ||
          cause instanceof ExchangeError.AuthorityDenied ||
          cause instanceof ExchangeError.AmbiguousCommit
        ) {
          return yield* Effect.fail(mapExchangeError(cause))
        }
        return yield* new OxpError.DependencyUnavailable({ detail: "OXP edit dependency is unavailable" })
      }
      const result = attempted.value
      scopedGrounding.note(root.id, target, result.fingerprint)
      return {
        title: result.title,
        output: result.output,
        metadata: result.metadata,
        mutation: result.mutation,
      } satisfies OxpResult.CapabilityResult
    })

    const execute: Interface["execute"] = (input, signal) =>
      Schema.decodeUnknownEffect(RuntimeParameters)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () =>
            new OxpError.InvalidArgument({
              detail:
                "Invalid OXP edit arguments. Choose exactly one strategy: content, exact, batch, line/range, delete, insert/append, or near-text.",
            }),
        ),
        Effect.flatMap((runtime) => executeRaw(runtime, signal)),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpGrounding.node, FSUtil.node],
})

export * as OxpEdit from "./edit"
