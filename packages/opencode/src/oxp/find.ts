import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ExchangeError } from "@/exchange/error"
import { ExchangeFind } from "@/exchange/find"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  glob: Schema.optional(Schema.String),
  grep: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  rootID: Schema.optional(OxpSchema.RootID),
  include: Schema.optional(Schema.String),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpFind") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: "OXP file search was cancelled" })
  return new OxpError.DependencyUnavailable({ detail: "OXP file search is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service

    const execute = Effect.fn("OxpFind.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* Effect.try({
        try: () => OxpLocation.requireExplicit(input, "find"),
        catch: (cause) =>
          OxpError.isError(cause)
            ? cause
            : new OxpError.InvalidArgument({ detail: "Invalid OXP find request" }),
      })

      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "find",
        phase: "read",
        rootID: input.rootID,
        path: input.path,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "find requires an approved root" })
      const target = OxpLocation.targetPath(admission.root)
      const root = admission.root.root
      return yield* ExchangeFind.execute(
        { fs, ripgrep },
        {
          path: target,
          rootLabel: root.alias,
          glob: input.glob,
          grep: input.grep,
          include: input.include,
          signal,
          projectionMarker: "<note>OXP find output truncated; narrow the path or pattern</note>",
          toDisplayPath: (value) => roots.toVirtualPath(root, value),
        },
        { revalidate: () => authority.revalidate(admission, "egress") },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, FSUtil.node, Ripgrep.node],
})

export * as OxpFind from "./find"
