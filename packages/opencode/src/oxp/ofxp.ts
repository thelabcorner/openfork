import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpRuntime } from "@/ofxp/runtime"
import { Parameters as NativeParameters } from "@/tool/ofxp"
import { normalizeBrokerArgs } from "@/tool/broker-args"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpResult } from "./result"

export const Parameters = NativeParameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpOfxp") {}
export const use = serviceUse(Service)

type Action = Input["action"]

function requireValue<T>(value: T | undefined, name: string, action: Action) {
  return value === undefined
    ? Effect.fail(new OxpError.InvalidArgument({ detail: `${name} is required for OFXP action=${action}` }))
    : Effect.succeed(value)
}

function mapError(error: unknown, signal?: AbortSignal): OxpError.Error {
  if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP OFXP request was cancelled" })
  const detail = error instanceof Error ? error.message : String(error)
  if (/required|invalid|schema|contract/i.test(detail)) return new OxpError.InvalidArgument({ detail: detail.slice(0, 1024) })
  if (/revoked|denied|pair/i.test(detail)) return new OxpError.AuthDenied({ detail: detail.slice(0, 1024) })
  return new OxpError.DependencyUnavailable({ detail: `OFXP peer operation failed: ${detail}`.slice(0, 1024) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const runtime = yield* OfxpRuntime.Service

    const execute = Effect.fn("OxpOfxp.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP OFXP request was cancelled" })
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: `integration.ofxp.${input.action}`,
        phase: input.action === "status" || input.action === "peers" ? "discover" : "network",
      })

      if (input.action === "status") {
        const status = yield* runtime.status()
        yield* authority.revalidate(admission, "egress")
        return { title: "OFXP status", output: JSON.stringify(status), structured: status, metadata: { action: input.action } }
      }

      if (input.action === "peers") {
        const [status, trusted, nearby] = yield* Effect.all([runtime.status(), runtime.trustedPeers(), runtime.candidates()])
        const online = new Set(nearby.map((item) => item.peerID))
        const peers = trusted.map((record) => ({
          peerID: record.info.id,
          label: record.info.label,
          realmID: record.info.realmID,
          online: status.active && online.has(record.info.id),
          rekeyState: record.info.rekeyState,
          ...(record.info.lastSeenAt === undefined ? {} : { lastSeenAt: record.info.lastSeenAt }),
        }))
        yield* authority.revalidate(admission, "egress")
        return {
          title: "Trusted OFXP peers",
          output: JSON.stringify({ active: status.active, peers }),
          structured: { active: status.active, peers },
          metadata: { action: input.action, count: peers.length },
        }
      }

      const peerID = yield* requireValue(input.peerID, "peerID", input.action)
      if (input.action === "roots") {
        const response = yield* runtime.remoteRoots(peerID, signal).pipe(Effect.mapError((error) => mapError(error, signal)))
        yield* authority.revalidate(admission, "egress")
        return { title: "Remote OFXP roots", output: JSON.stringify(response), structured: response, metadata: { action: input.action, peerID } }
      }
      if (input.action === "list") {
        const response = yield* runtime.remoteCapabilities(peerID, input.rootID, signal).pipe(Effect.mapError((error) => mapError(error, signal)))
        yield* authority.revalidate(admission, "egress")
        return { title: "Remote OFXP capabilities", output: JSON.stringify(response), structured: response, metadata: { action: input.action, peerID } }
      }
      if (input.action === "receipt") {
        const invocationID = yield* requireValue(input.invocationID, "invocationID", input.action)
        const response = yield* runtime.remoteReceipt(peerID, invocationID, signal).pipe(
          Effect.mapError((error) => mapError(error, signal)),
        )
        yield* authority.revalidate(admission, "egress")
        return {
          title: response.ok ? `OFXP receipt ${invocationID}` : "OFXP receipt unavailable",
          output: JSON.stringify(response),
          structured: response,
          metadata: { action: input.action, peerID, invocationID, ok: response.ok },
        }
      }

      const capability = yield* requireValue(input.capability, "capability", input.action)
      if (input.action === "describe") {
        const response = yield* runtime.describeRemoteCapability(peerID, capability, signal).pipe(Effect.mapError((error) => mapError(error, signal)))
        yield* authority.revalidate(admission, "egress")
        return { title: `Describe remote ${capability}`, output: JSON.stringify(response), structured: response, metadata: { action: input.action, peerID, capability } }
      }

      const contract = yield* requireValue(input.contract, "contract", input.action)
      const args = yield* Effect.try({
        try: () => normalizeBrokerArgs(input.args, { broker: "ofxp" }),
        catch: (cause) => new OxpError.InvalidArgument({ detail: OxpError.boundDetail(cause) }),
      })
      const state = yield* config.get()
      const invocationID = input.invocationID ?? Ofxp.InvocationID.create()
      const response = yield* runtime.invokeRemoteCapability(
        {
          peerID,
          invocationID,
          source: { kind: "external", principal: `oxp:${state.connector.id}` } satisfies Ofxp.InvocationSource,
          ...(input.rootID ? { rootID: input.rootID } : {}),
          capability,
          contract,
          args,
        },
        signal,
      ).pipe(Effect.mapError((error) => mapError(error, signal)))
      yield* authority.revalidate(admission, "egress")
      if (!response.ok) {
        return {
          title: `Remote ${capability} failed`,
          output: JSON.stringify(response),
          structured: response,
          metadata: {
            action: input.action,
            peerID,
            ...(input.rootID ? { rootID: input.rootID } : {}),
            capability,
            invocationID,
            ok: false,
          },
        }
      }
      return {
        title: response.result.title,
        output: response.result.output,
        structured: response,
        attachments: response.result.attachments,
        metadata: {
          action: input.action,
          peerID,
          ...(input.rootID ? { rootID: input.rootID } : {}),
          capability,
          invocationID,
          ok: true,
          ...(response.result.attachments?.length ? { remoteAttachments: response.result.attachments.length } : {}),
        },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute: (input, signal) => execute(input, signal).pipe(Effect.mapError((error) => OxpError.isError(error) ? error : mapError(error, signal))) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node, OxpConfig.node, OfxpRuntime.node] })

export * as OxpOfxp from "./ofxp"
