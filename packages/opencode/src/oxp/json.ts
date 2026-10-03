import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeError } from "@/exchange/error"
import { ExchangeJson } from "@/exchange/json"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: Schema.optional(OxpSchema.RootID).annotate({
    description: "Approved OXP root for file-backed JSON operations. Inline jsonText operations do not require a root.",
  }),
  ...ExchangeJson.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpJson") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.detail) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service

    const execute: Interface["execute"] = Effect.fn("OxpJson.execute")(function* (input, signal) {
      const state = yield* config.get()
      if (!state.enabled) return yield* new OxpError.AuthDenied({ detail: "OXP is disabled" })

      const readAdmissions = new Map<string, OxpAuthority.Admission>()
      const writeAdmissions = new Map<string, OxpAuthority.Admission>()
      const key = (value: string) => FSUtil.normalizePath(value)
      const resolve = (operation: "json.read" | "json.write", inputPath: string) =>
        Effect.gen(function* () {
          yield* OxpLocation.requireExplicit(
            { rootID: input.rootID, path: inputPath },
            "json",
          )
          const admission = yield* authority.authorize({
            plane: "augmentation",
            operation,
            phase: operation === "json.write" ? "mutate" : "read",
            rootID: input.rootID,
            path: inputPath,
          })
          if (!admission.root || !("path" in admission.root)) {
            return yield* new OxpError.RootRequired({ detail: "JSON file input requires an approved file path" })
          }
          const resolved = admission.root
          ;(operation === "json.write" ? writeAdmissions : readAdmissions).set(key(resolved.path), admission)
          return {
            native: resolved.path,
            virtual: resolved.virtualPath,
            rootID: resolved.root.id,
          } satisfies ExchangeJson.ApprovedPath
        })

      const retained = Effect.fnUntraced(function* (target: ExchangeJson.ApprovedPath, mode: "read" | "write") {
        const admission = (mode === "read" ? readAdmissions : writeAdmissions).get(key(target.native))
        if (!admission) {
          return yield* new OxpError.DependencyUnavailable({
            detail: `JSON ${mode} admission was not retained for revalidation`,
          })
        }
        return admission
      })

      const revalidateRead = (target: ExchangeJson.ApprovedPath) =>
        Effect.gen(function* () {
          const admission = yield* retained(target, "read")
          yield* authority.revalidate(admission, "egress")
        })

      const revalidateWrite = (target: ExchangeJson.ApprovedPath) =>
        Effect.gen(function* () {
          const admission = yield* retained(target, "write")
          const fresh = yield* authority.revalidate(admission, "commit")
          if (!fresh.root || !("path" in fresh.root)) {
            return yield* new OxpError.AuthRevoked({
              detail: "OXP JSON write authority changed before commit",
            })
          }
          if (FSUtil.normalizePath(fresh.root.path) !== FSUtil.normalizePath(target.native)) {
            return yield* new OxpError.AuthRevoked({
              detail: "OXP JSON target identity changed before commit",
            })
          }
        })

      const { rootID: _rootID, ...params } = input
      const scopedGrounding = grounding.scoped(state.connector.id)
      const result = yield* ExchangeJson.execute<OxpError.Error>(
        fs,
        params,
        {
          resolveRead: (inputPath) => resolve("json.read", inputPath),
          resolveWrite: (inputPath) => resolve("json.write", inputPath),
          revalidateRead,
          revalidateWrite,
          grounding: {
            note: (rootID, inputPath, fingerprint) =>
              scopedGrounding.note(OxpSchema.RootID.make(rootID), inputPath, fingerprint),
            get: (rootID, inputPath) =>
              scopedGrounding.get(OxpSchema.RootID.make(rootID), inputPath),
            remove: (rootID, inputPath) =>
              scopedGrounding.remove(OxpSchema.RootID.make(rootID), inputPath),
          },
        },
        signal,
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))

      return {
        title: result.title,
        output: result.output,
        structured: result.metadata,
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

export * as OxpJson from "./json"
