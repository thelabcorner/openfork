import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Symbols } from "@/symbols/service"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Approved OXP root that owns the symbol-analysis scope.",
  }),
  ...Symbols.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSymbols") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const symbols = yield* Symbols.Service

    const execute = Effect.fn("OxpSymbols.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP symbols request was cancelled" })

      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "symbols",
        phase: "read",
        rootID: input.rootID,
      })
      if (!admission.root || "path" in admission.root) {
        return yield* new OxpError.RootRequired({ detail: "symbols requires one explicit approved root" })
      }
      const root = admission.root

      const { rootID: _rootID, ...symbolInput } = input
      let resolvedPath = symbolInput.path
      let resolvedFile = symbolInput.file

      if (input.path) {
        const scoped = yield* authority.authorize({
          plane: "augmentation",
          operation: "symbols",
          phase: "read",
          rootID: input.rootID,
          path: input.path,
        })
        if (!scoped.root || !("path" in scoped.root)) {
          return yield* new OxpError.InvalidArgument({ detail: "symbols path did not resolve to an approved target" })
        }
        resolvedPath = scoped.root.path
      }

      if (input.file) {
        const file = yield* authority.authorize({
          plane: "augmentation",
          operation: "symbols",
          phase: "read",
          rootID: input.rootID,
          path: input.file,
        })
        if (!file.root || !("path" in file.root)) {
          return yield* new OxpError.InvalidArgument({ detail: "symbols file did not resolve to an approved target" })
        }
        resolvedFile = file.root.path
      }

      const resolved: Symbols.Input = {
        ...symbolInput,
        ...(resolvedPath === undefined ? {} : { path: resolvedPath }),
        ...(resolvedFile === undefined ? {} : { file: resolvedFile }),
      }

      const result = yield* symbols
        .execute(resolved, {
          directory: root.canonicalPath,
          worktree: root.canonicalPath,
          abort: signal,
        })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "SymbolsInvalidInput") {
              // Shared symbol diagnostics may contain native absolute paths.
              // Project the approved root back to its virtual OXP identity.
              const virtual = `/${root.root.alias}`
              const detail = error.detail.split(root.canonicalPath).join(virtual)
              return new OxpError.InvalidArgument({ detail })
            }
            if (
              error._tag === "Ripgrep.Error" &&
              error.cause instanceof Error &&
              error.cause.name === "AbortError"
            ) {
              return new OxpError.Cancelled({ detail: "OXP symbols request was cancelled" })
            }
            return new OxpError.DependencyUnavailable({ detail: "OXP symbol analysis is unavailable" })
          }),
        )

      yield* authority.revalidate(admission, "egress")
      return {
        title: result.title,
        output: result.output,
        metadata: result.metadata,
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, Symbols.node],
})

export * as OxpSymbols from "./symbols"
