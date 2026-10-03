import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ExchangeError } from "@/exchange/error"
import { ExchangeProject } from "@/exchange/project"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export type Action = "summary" | "structure" | "recent"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["summary", "structure", "recent"])),
  path: Schema.optional(Schema.String),
  rootID: Schema.optional(OxpSchema.RootID),
  depth: Schema.optional(Schema.Number),
  maxEntries: Schema.optional(Schema.Number),
  recent: Schema.optional(Schema.Number),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpProject") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: "OXP project inspection was cancelled" })
  return new OxpError.DependencyUnavailable({ detail: "OXP project inspection is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const ripgrep = yield* Ripgrep.Service

    const execute = Effect.fn("OxpProject.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* OxpLocation.requireExplicit(input, "project")
      const action = input.action ?? "summary"
      if (action !== "summary" && action !== "structure" && action !== "recent") {
        return yield* new OxpError.InvalidArgument({ detail: "Unknown OXP project action" })
      }
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "project",
        phase: "read",
        rootID: input.rootID,
        path: input.path,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "project requires an approved root" })
      const root = admission.root.root
      const target = OxpLocation.targetPath(admission.root)
      return yield* ExchangeProject.execute(
        ripgrep,
        {
          root: root.path,
          scope: target,
          displayPath: roots.toVirtualPath(root, target),
          rootLabel: root.alias,
          action,
          depth: input.depth,
          maxEntries: input.maxEntries,
          recent: input.recent,
          signal,
          projectionMarker: "<note>OXP project output truncated; narrow the project path or request</note>",
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
  deps: [OxpAuthority.node, OxpRoot.node, Ripgrep.node],
})

export * as OxpProject from "./project"
