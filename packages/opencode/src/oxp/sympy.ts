import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSympy } from "@/exchange/sympy"
import { OxpError } from "./error"
import { OxpProcess } from "./process"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root used as the symbolic-computation working directory." }),
  ...ExchangeSympy.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSympy") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* OxpProcess.Service

    const execute: Interface["execute"] = Effect.fn("OxpSympy.execute")(function* (input, signal) {
      const result = yield* ExchangeSympy.execute<OxpError.Error>(
        input,
        {
          run: (request) =>
            proc.runArgv(
              {
                rootID: input.rootID,
                argv: request.argv,
                workdir: request.workdir,
                env: request.env,
                title: request.title,
                operation: request.operation,
                timeoutMs: request.timeoutMs,
                outputCapBytes: request.outputCapBytes,
              },
              request.signal,
            ),
          isCandidateUnavailable: (error) => error._tag === "OXP_DEPENDENCY_UNAVAILABLE",
        },
        signal,
      ).pipe(
        Effect.mapError((error) =>
          error instanceof ExchangeError.InvalidArgument
            ? new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
            : error instanceof ExchangeError.Cancelled
              ? new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
              : error,
        ),
      )
      return {
        title: result.title,
        output: result.output,
        structured: result.metadata,
        metadata: result.metadata,
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpProcess.node] })
export * as OxpSympy from "./sympy"
