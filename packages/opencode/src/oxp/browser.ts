import { Context, Effect, Layer, Schema } from "effect"
import { BrowserHostBroker, BrowserOperationFailedError } from "@opencode-ai/core/browser/host-broker"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { DEFAULT_TIMEOUT_MS, OperationInput, OperationOutput, toBrowserError, type OperationName } from "@/browser/shared"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

const OPERATION_SCHEMAS = [
  Schema.Struct({ operation: Schema.Literal("status"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.status }),
  Schema.Struct({ operation: Schema.Literal("open"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.open }),
  Schema.Struct({ operation: Schema.Literal("claim"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.claim }),
  Schema.Struct({ operation: Schema.Literal("navigate"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.navigate }),
  Schema.Struct({ operation: Schema.Literal("resize"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.resize }),
  Schema.Struct({ operation: Schema.Literal("set_appearance"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.set_appearance }),
  Schema.Struct({ operation: Schema.Literal("snapshot"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.snapshot }),
  Schema.Struct({ operation: Schema.Literal("screenshot"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.screenshot }),
  Schema.Struct({ operation: Schema.Literal("visual_capture"), rootID: OxpSchema.RootID, args: OperationInput.visual_capture }),
  Schema.Struct({ operation: Schema.Literal("visual_diff"), rootID: OxpSchema.RootID, args: OperationInput.visual_diff }),
  Schema.Struct({ operation: Schema.Literal("visual_record"), rootID: OxpSchema.RootID, args: OperationInput.visual_record }),
  Schema.Struct({ operation: Schema.Literal("visual_history"), rootID: OxpSchema.RootID, args: OperationInput.visual_history }),
  Schema.Struct({ operation: Schema.Literal("visual_artifact"), rootID: OxpSchema.RootID, args: OperationInput.visual_artifact }),
  Schema.Struct({ operation: Schema.Literal("click"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.click }),
  Schema.Struct({ operation: Schema.Literal("type"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.type }),
  Schema.Struct({ operation: Schema.Literal("press"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.press }),
  Schema.Struct({ operation: Schema.Literal("scroll"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.scroll }),
  Schema.Struct({ operation: Schema.Literal("evaluate"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.evaluate }),
  Schema.Struct({ operation: Schema.Literal("wait_for"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.wait_for }),
  Schema.Struct({ operation: Schema.Literal("recording_start"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.recording_start }),
  Schema.Struct({ operation: Schema.Literal("recording_stop"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.recording_stop }),
  Schema.Struct({ operation: Schema.Literal("close"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.close }),
  Schema.Struct({ operation: Schema.Literal("query"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.query }),
  Schema.Struct({ operation: Schema.Literal("highlight"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.highlight }),
  Schema.Struct({ operation: Schema.Literal("annotate"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.annotate }),
  Schema.Struct({ operation: Schema.Literal("profiler_start"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.profiler_start }),
  Schema.Struct({ operation: Schema.Literal("profiler_stop"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.profiler_stop }),
  Schema.Struct({ operation: Schema.Literal("react_inspect"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.react_inspect }),
  Schema.Struct({ operation: Schema.Literal("open_devtools"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.open_devtools }),
  Schema.Struct({ operation: Schema.Literal("extensions_list"), rootID: Schema.optionalKey(OxpSchema.RootID), args: OperationInput.extensions_list }),
] as const

export const Parameters = Schema.Union(OPERATION_SCHEMAS)
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    parentConversationRef?: string,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpBrowser") {}
export const use = serviceUse(Service)

const VISUAL_ROOT_OPERATIONS = new Set<OperationName>([
  "visual_capture",
  "visual_diff",
  "visual_record",
  "visual_history",
  "visual_artifact",
])

function mapBrowserError(error: BrowserHostBroker.BrowserErrorClass): OxpError.Error {
  const projected = toBrowserError({
    tag: error._tag,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  })
  const metadata = { browserError: projected._tag, retryable: projected.retryable }
  switch (projected._tag) {
    case "BrowserPermissionDenied":
      return new OxpError.AuthDenied({ detail: OxpError.boundDetail(projected.message), metadata })
    case "BrowserTabNotFound":
      return new OxpError.NotFound({ detail: OxpError.boundDetail(projected.message), metadata })
    case "BrowserTimeout":
      return new OxpError.Timeout({ detail: OxpError.boundDetail(projected.message), metadata })
    case "BrowserControlInterrupted":
      return new OxpError.Cancelled({ detail: OxpError.boundDetail(projected.message), metadata })
    case "BrowserInvalidSelector":
    case "BrowserStaleRefError":
    case "BrowserNotAReactAppError":
      return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(projected.message), metadata })
    case "BrowserHostUnavailable":
    case "BrowserProtocolMismatch":
    case "BrowserGuestCrashed":
    case "BrowserResultTooLarge":
    case "BrowserDebuggerConflict":
    case "BrowserUnsupportedOperation":
    case "BrowserNotAttached":
    case "BrowserOperationFailed":
    case "BrowserTargetNotFound":
      return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(projected.message), metadata })
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const broker = yield* BrowserHostBroker.Service

    const execute = Effect.fn("OxpBrowser.execute")(function* (
      input: Input,
      parentConversationRef?: string,
      signal?: AbortSignal,
    ) {
      const operation = input.operation as OperationName
      const visualRoot = VISUAL_ROOT_OPERATIONS.has(operation)
      if (visualRoot && !input.rootID) {
        return yield* new OxpError.RootRequired({ detail: `browser.${operation} requires an explicit approved root` })
      }
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: `browser.${operation}`,
        phase: "control",
        ...(input.rootID ? { rootID: input.rootID } : {}),
      })
      if (!parentConversationRef) {
        return yield* new OxpError.AuthDenied({
          detail: "OXP browser control requires a stable ChatGPT parent-conversation identity",
        })
      }
      const state = admission.root
      const principalId = `oxp:${admission.connectorID}:${parentConversationRef}`
      const timeoutMs = "timeoutMs" in input.args && typeof input.args.timeoutMs === "number"
        ? input.args.timeoutMs
        : DEFAULT_TIMEOUT_MS[operation]
      const response = yield* broker.dispatch(
        {
          principal: { kind: "external", principalId },
          ...(state ? { directory: state.canonicalPath } : {}),
          operation: { name: operation, input: input.args },
          timeoutMs,
        },
        { signal },
      )
      if (!response.ok) return yield* mapBrowserError(BrowserHostBroker.BrowserError.fromPayload(response.error))
      yield* authority.revalidate(admission, "egress")

      const result = yield* Schema.decodeUnknownEffect(OperationOutput[operation] as Schema.Decoder<unknown, never>)(response.result).pipe(
        Effect.mapError(
          (cause) =>
            new OxpError.DependencyUnavailable({
              detail: `Desktop browser returned an invalid ${operation} result: ${String(cause)}`,
            }),
        ),
      )
      return {
        title: `Browser ${operation}`,
        output: JSON.stringify(result),
        structured: result,
        metadata: {
          operation,
          requestId: response.requestId,
          elapsedMs: response.elapsedMs,
          ...(response.snapshotAfter ? { snapshotAfter: response.snapshotAfter } : {}),
        },
        mutation: {
          attempted: operation !== "status" && operation !== "snapshot" && operation !== "screenshot" && operation !== "query" && operation !== "visual_history" && operation !== "visual_artifact" && operation !== "react_inspect" && operation !== "extensions_list",
          committed: response.ok,
        },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, BrowserHostBroker.node],
})

export * as OxpBrowser from "./browser"
