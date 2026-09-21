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
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const BatchOp = Schema.Union([
  Schema.Struct({
    line: PositiveInt,
    newText: Schema.String,
    oldText: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    startLine: PositiveInt,
    endLine: PositiveInt,
    newText: Schema.optional(Schema.String),
    oldText: Schema.optional(Schema.String),
    delete: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    oldString: Schema.String,
    newString: Schema.String,
  }),
])

export const Parameters = Schema.Struct({
  path: Schema.String,
  rootID: Schema.optional(OxpSchema.RootID),
  oldString: Schema.optional(Schema.String),
  newString: Schema.optional(Schema.String),
  replaceAll: Schema.optional(Schema.Boolean),
  edits: Schema.optional(Schema.Array(BatchOp).check(Schema.isMaxLength(128))),
  line: Schema.optional(PositiveInt),
  startLine: Schema.optional(PositiveInt),
  endLine: Schema.optional(PositiveInt),
  insertAt: Schema.optional(NonNegativeInt),
  insertAfter: Schema.optional(PositiveInt),
  appendFile: Schema.optional(Schema.Boolean),
  nearText: Schema.optional(Schema.String),
  occurrence: Schema.optional(PositiveInt),
  oldText: Schema.optional(Schema.String),
  newText: Schema.optional(Schema.String),
  delete: Schema.optional(Schema.Boolean),
})
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
      const result = yield* ExchangeEdit.execute(
        fs,
        {
          path: input.path,
          oldString: input.oldString,
          newString: input.newString,
          replaceAll: input.replaceAll,
          edits: input.edits,
          line: input.line,
          startLine: input.startLine,
          endLine: input.endLine,
          insertAt: input.insertAt,
          insertAfter: input.insertAfter,
          appendFile: input.appendFile,
          nearText: input.nearText,
          occurrence: input.occurrence,
          oldText: input.oldText,
          newText: input.newText,
          delete: input.delete,
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
