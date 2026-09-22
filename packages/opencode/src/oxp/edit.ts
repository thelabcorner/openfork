import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeEdit } from "@/exchange/edit"
import { ExchangeError } from "@/exchange/error"
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
  path: Schema.String,
  rootID: Schema.optionalKey(OxpSchema.RootID),
})

const ExactEdit = Schema.Struct({
  ...Target.fields,
  oldString: NonEmptyText,
  newString: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
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
 * Keep the model-facing contract strategy-shaped instead of exposing one bag of
 * mutually-exclusive optional fields. This makes invalid mixed/no-strategy
 * calls unrepresentable in the generated MCP schema while preserving the
 * existing flat wire keys for every valid edit.
 */
export const Parameters = Schema.Union([
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
export type Input = Schema.Schema.Type<typeof Parameters>

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

    const execute = Effect.fn("OxpEdit.execute")(function* (input: Input, signal?: AbortSignal) {
      OxpLocation.requireExplicit(input, "edit")
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "edit",
        phase: "mutate",
        rootID: input.rootID,
        path: input.path,
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
      const { rootID: _rootID, ...editInput } = input
      const result = yield* ExchangeEdit.execute(
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
          revalidate: () =>
            Effect.gen(function* () {
              const freshAdmission = yield* authority.revalidate(admission, "commit")
              if (!freshAdmission.root || !("path" in freshAdmission.root)) {
                return yield* new OxpError.AuthRevoked({ detail: "OXP edit authority changed before commit" })
              }
              if (FSUtil.normalizePath(freshAdmission.root.path) !== FSUtil.normalizePath(target)) {
                return yield* new OxpError.AuthRevoked({ detail: "OXP edit target identity changed before commit" })
              }
            }),
          beforeCommit: () => Effect.void,
        },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
      scopedGrounding.note(root.id, target, result.fingerprint)
      return {
        title: result.title,
        output: result.output,
        metadata: result.metadata,
        mutation: result.mutation,
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpGrounding.node, FSUtil.node],
})

export * as OxpEdit from "./edit"
