import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AppProcess } from "@opencode-ai/core/process"
import { ExchangeError } from "@/exchange/error"
import { ExchangeProject } from "@/exchange/project"
import { ProjectToolchain } from "@/project/toolchain"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export type Action = "snapshot" | "summary" | "structure" | "recent" | "toolchain"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["snapshot", "summary", "structure", "recent", "toolchain"])),
  tier: Schema.optional(Schema.Literals(["summary", "structure", "full"])).annotate({
    description:
      'Snapshot detail (default summary). Use action="snapshot", tier="full" for bounded scripts, entry points, config, CI, tree and per-extension statistics. summary overrides tier.',
  }),
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
  if (error instanceof ExchangeError.InvalidArgument)
    return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled)
    return new OxpError.Cancelled({ detail: "OXP project inspection was cancelled" })
  return new OxpError.DependencyUnavailable({ detail: "OXP project inspection is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const ripgrep = yield* Ripgrep.Service
    const app = yield* AppProcess.Service

    const execute = Effect.fn("OxpProject.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* OxpLocation.requireExplicit(input, "project")
      const action = input.action ?? "summary"
      if (
        action !== "snapshot" &&
        action !== "summary" &&
        action !== "structure" &&
        action !== "recent" &&
        action !== "toolchain"
      ) {
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
      if (action === "toolchain") {
        // Execution is strictly stronger than project metadata read. Reuse
        // the native tool's shared bounded probe, but require the independent
        // OXP process grant and revalidate both grants before emitting data.
        const processAdmission = yield* authority.authorize({
          plane: "augmentation",
          operation: "process",
          phase: "control",
          rootID: input.rootID,
          path: input.path,
        })
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Toolchain inspection cancelled" })
        const inspected = yield* ProjectToolchain.probe(app, signal ?? new AbortController().signal)
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Toolchain inspection cancelled" })
        yield* authority.revalidate(admission, "egress")
        yield* authority.revalidate(processAdmission, "egress")
        return {
          title: "toolchain",
          output: ProjectToolchain.render(inspected, {
            // OXP project.read does not have native Git provenance. Never
            // falsely report "not a Git repo" without explicit Git authority.
            git: "unknown",
            externalPrincipal: true,
            root: roots.toVirtualPath(root, target),
          }),
          metadata: { action, root: root.alias, runtimes: inspected.runtimes.length, authority: "read+process" },
        } satisfies OxpResult.CapabilityResult
      }
      return yield* ExchangeProject.execute(
        ripgrep,
        {
          root: root.path,
          scope: target,
          displayPath: roots.toVirtualPath(root, target),
          rootLabel: root.alias,
          action,
          tier: input.tier,
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
  deps: [OxpAuthority.node, OxpRoot.node, Ripgrep.node, AppProcess.node],
})

export * as OxpProject from "./project"
