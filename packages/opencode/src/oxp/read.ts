import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { ExchangeRead } from "@/exchange/read"
import { OxpAuthority } from "./authority"
import { OxpAttribution } from "./attribution"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500
const MAX_BATCH = 8

export const Window = Schema.Struct({
  path: Schema.String,
  rootID: Schema.optional(OxpSchema.RootID),
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
})
export type Window = Schema.Schema.Type<typeof Window>

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String),
  rootID: Schema.optional(OxpSchema.RootID),
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  action: Schema.optional(Schema.Literals(["read", "tail"])),
  reads: Schema.optional(Schema.Array(Window).check(Schema.isMaxLength(MAX_BATCH))),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpRead") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeRead.Error): OxpError.Error {
  if (error instanceof ExchangeRead.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeRead.Cancelled) return new OxpError.Cancelled({ detail: "OXP read was cancelled" })
  if (error instanceof ExchangeRead.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: "OXP read dependency is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service

    const one = Effect.fn("OxpRead.one")(function* (window: Window, action: "read" | "tail", signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP read was cancelled" })
      OxpLocation.requireExplicit(window, "read")
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: window.rootID,
        path: window.path,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "read requires an approved root" })
      const target = OxpLocation.targetPath(admission.root)
      const root = admission.root.root
      const virtualPath = roots.toVirtualPath(root, target)
      const execution = yield* ExchangeRead.execute(
        fs,
        {
          path: target,
          displayPath: virtualPath,
          action,
          offset: window.offset,
          limit: window.limit,
          signal,
          projectionMarker: "<note>OXP read output truncated; narrow the read window</note>",
          // The shared exchange read already publishes the one canonical
          // CodingActivity record for this read, so attribution is supplied here
          // rather than emitted a second time. It is derived from the approved
          // root this call's admission re-verified on disk, not from the virtual
          // path spelling, so a nested file and a file at the root name one
          // project — and one canonical project folder — instead of a parent
          // directory. Exactly-once is preserved: the folder enriches the record
          // the exchange read already emits and never adds a second one.
          attribution: OxpAttribution.attribution(admission.root),
        },
        { revalidate: () => authority.revalidate(admission, "egress") },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
      if (!execution.fingerprint) return execution.result satisfies OxpResult.CapabilityResult

      const current = yield* config.get()
      grounding.scoped(current.connector.id).note(root.id, target, execution.fingerprint)
      return {
        ...execution.result,
        metadata: { ...execution.result.metadata, grounded: true },
      } satisfies OxpResult.CapabilityResult
    })

    const execute = Effect.fn("OxpRead.execute")(function* (input: Input, signal?: AbortSignal) {
      const action = input.action ?? "read"
      if (input.reads && (input.path !== undefined || input.offset !== undefined || input.limit !== undefined)) {
        return yield* new OxpError.InvalidArgument({ detail: "reads[] cannot be combined with top-level read location/window fields" })
      }
      if (input.reads) {
        if (action !== "read") return yield* new OxpError.InvalidArgument({ detail: "reads[] supports plain read windows only" })
        if (input.reads.length === 0 || input.reads.length > MAX_BATCH) {
          return yield* new OxpError.InvalidArgument({ detail: `reads[] must contain 1-${MAX_BATCH} targets` })
        }
        const results: OxpResult.CapabilityResult[] = []
        for (const item of input.reads) {
          if (input.rootID && item.rootID && item.rootID !== input.rootID) {
            return yield* new OxpError.InvalidArgument({
              detail: "reads[] item rootID conflicts with the top-level rootID",
            })
          }
          results.push(
            yield* one(
              {
                ...item,
                rootID: item.rootID ?? input.rootID,
              },
              "read",
              signal,
            ),
          )
        }
        const joined = results.map((result) => result.output).join("\n\n")
        const projected = ToolOutputProjection.project(joined, {
          maxLines: OUTPUT_LINES,
          maxBytes: OUTPUT_BYTES,
          strategy: "head",
          marker: "<note>OXP batched read output truncated; narrow the read windows</note>",
        })
        return {
          title: `read ${results.length} targets`,
          output: projected.content,
          attachments: results.flatMap((result) => result.attachments ?? []),
          metadata: { action: "read", targets: results.length, truncated: projected.truncated || results.some((result) => result.metadata?.truncated === true) },
        } satisfies OxpResult.CapabilityResult
      }
      if (!input.path) return yield* new OxpError.InvalidArgument({ detail: "read requires path or reads[]" })
      return yield* one({ path: input.path, rootID: input.rootID, offset: input.offset, limit: input.limit }, action, signal)
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpRoot.node, OxpGrounding.node, FSUtil.node],
})

export * as OxpRead from "./read"
