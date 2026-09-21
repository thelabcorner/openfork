import { Effect, Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID as ProtocolSessionID } from "@opencode-ai/schema/session-id"
import { OfxpRuntime } from "@/ofxp/runtime"
import { BrokerContract } from "./broker-contract"
import { normalizeBrokerArgs, withContractedBrokerArgsSchema } from "./broker-args"
import { ToolJsonSchema } from "./json-schema"
import * as Tool from "./tool"

const ACTIONS = ["status", "peers", "roots", "list", "describe", "call", "receipt"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "status = local OFXP state; peers = trusted remote OpenFork peers; roots = roots the selected peer grants this instance; list = remote capability summaries; describe = exact remote capability schema/contract; call = invoke that described capability; receipt = reconcile one mutation by InvocationID.",
  }),
  peerID: Schema.optional(Ofxp.PeerID).annotate({
    description: "Trusted remote OFXP peer ID. Required for roots/list/describe/call.",
  }),
  rootID: Schema.optional(Ofxp.RootID).annotate({
    description: "Remote approved root ID. Required for call only when the described capability says requiresRoot=true or the selected operation requires project scope.",
  }),
  capability: Schema.optional(Ofxp.CapabilityID).annotate({
    description: "Remote capability ID returned by list. Required for describe/call.",
  }),
  invocationID: Schema.optional(Ofxp.InvocationID).annotate({
    description:
      "Stable idempotency/reconciliation key. For call, reuse the same invocationID when retrying the same mutation. Required for receipt.",
  }),
  contract: BrokerContract.Parameter,
  args: Schema.optional(Schema.Unknown).annotate({
    description:
      "Remote capability arguments for action=call. Pass a JSON object satisfying the exact inputSchema returned by describe; never pass the schema itself.",
  }),
})

const ProviderParameters = withContractedBrokerArgsSchema(ToolJsonSchema.fromSchema(Parameters))

type Action = (typeof ACTIONS)[number]
type Metadata = {
  ofxpAction: Action
  peerID?: string
  rootID?: string
  capability?: string
  invocationID?: string
  ok?: boolean
  count?: number
  remoteAttachments?: number
}

function requireValue<T>(value: T | undefined, name: string, action: Action): Effect.Effect<T, Error> {
  return value === undefined ? Effect.fail(new Error(`${name} is required for OFXP action=${action}`)) : Effect.succeed(value)
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function failure(action: Action, error: unknown, metadata: Omit<Metadata, "ofxpAction" | "ok"> = {}): Tool.ExecuteResult<Metadata> {
  const message = error instanceof Error ? error.message : String(error)
  return {
    title: "OFXP unavailable",
    output: `OFXP ${action} failed: ${message}`,
    metadata: { ofxpAction: action, ...metadata, ok: false },
  }
}

export const OfxpTool = Tool.define<typeof Parameters, Metadata, OfxpRuntime.Service>(
  "ofxp",
  Effect.gen(function* () {
    const runtime = yield* OfxpRuntime.Service
    return {
      description: [
        "Use trusted OpenFork peers over OFXP without manual host/port handling.",
        "This tool cannot pair peers, change trust, approve roots, widen grants, revoke peers, or start/stop OFXP; those are operator-owned settings.",
        "Use peers to choose a trusted machine, roots to discover the roots that machine grants this OpenFork instance, list to discover remote capabilities, then describe before every call and echo the returned contract exactly.",
        "Remote schemas stay lazy: never guess capability arguments or reuse a contract from another peer/capability.",
      ].join(" "),
      parameters: Parameters,
      jsonSchema: ProviderParameters,
      execute: (input, ctx) => {
        const callInvocationID = input.action === "call" ? (input.invocationID ?? Ofxp.InvocationID.create()) : input.invocationID
        return Effect.gen(function* () {
          if (input.action === "status") {
            const status = yield* runtime.status()
            return {
              title: "OFXP status",
              output: pretty(status),
              metadata: { ofxpAction: input.action, ok: true },
            }
          }

          if (input.action === "peers") {
            const [status, trusted, nearby] = yield* Effect.all([
              runtime.status(),
              runtime.trustedPeers(),
              runtime.candidates(),
            ])
            const online = new Set(nearby.map((item) => item.peerID))
            const peers = trusted.map((record) => ({
              peerID: record.info.id,
              label: record.info.label,
              realmID: record.info.realmID,
              online: status.active && online.has(record.info.id),
              rekeyState: record.info.rekeyState,
              ...(record.info.lastSeenAt === undefined ? {} : { lastSeenAt: record.info.lastSeenAt }),
            }))
            return {
              title: "Trusted OFXP peers",
              output: pretty({ active: status.active, peers }),
              metadata: { ofxpAction: input.action, ok: true, count: peers.length },
            }
          }

          const peerID = yield* requireValue(input.peerID, "peerID", input.action)

          if (input.action === "roots") {
            const response = yield* runtime.remoteRoots(peerID, ctx.abort)
            return {
              title: response.ok ? "Remote OFXP roots" : "OFXP root access denied",
              output: pretty(response),
              metadata: {
                ofxpAction: input.action,
                peerID,
                ok: response.ok,
                ...(response.ok ? { count: response.roots.length } : {}),
              },
            }
          }

          if (input.action === "list") {
            const response = yield* runtime.remoteCapabilities(peerID, input.rootID, ctx.abort)
            return {
              title: response.ok ? "Remote OFXP capabilities" : "OFXP capability access denied",
              output: pretty(response),
              metadata: {
                ofxpAction: input.action,
                peerID,
                ...(input.rootID ? { rootID: input.rootID } : {}),
                ok: response.ok,
                ...(response.ok ? { count: response.capabilities.length } : {}),
              },
            }
          }

          if (input.action === "receipt") {
            const invocationID = yield* requireValue(input.invocationID, "invocationID", input.action)
            const response = yield* runtime.remoteReceipt(peerID, invocationID, ctx.abort)
            return {
              title: response.ok ? `OFXP receipt ${invocationID}` : "OFXP receipt unavailable",
              output: pretty(response),
              metadata: { ofxpAction: input.action, peerID, invocationID, ok: response.ok },
            }
          }

          const capability = yield* requireValue(input.capability, "capability", input.action)
          if (input.action === "describe") {
            const response = yield* runtime.describeRemoteCapability(peerID, capability, ctx.abort)
            return {
              title: response.ok ? `Describe remote ${capability}` : "OFXP capability unavailable",
              output: pretty(response),
              metadata: { ofxpAction: input.action, peerID, capability, ok: response.ok },
            }
          }

          const contract = yield* requireValue(input.contract, "contract", input.action)
          const invocationID = callInvocationID!
          const args = yield* Effect.try({
            try: () => normalizeBrokerArgs(input.args, { broker: "ofxp" }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          })
          const response = yield* runtime.invokeRemoteCapability(
            {
              peerID,
              invocationID,
              sourceSessionID: ProtocolSessionID.descending(ctx.sessionID),
              ...(input.rootID ? { rootID: input.rootID } : {}),
              capability,
              contract,
              args,
            },
            ctx.abort,
          )
          if (!response.ok) {
            return {
              title: `Remote ${capability} failed`,
              output: pretty(response),
              metadata: { ofxpAction: input.action, peerID, ...(input.rootID ? { rootID: input.rootID } : {}), capability, invocationID, ok: false },
            }
          }

          const attachments = response.result.attachments ?? []
          const attachmentNote = attachments.length
            ? `\n\n<remote-attachments>${pretty(attachments)}</remote-attachments>\n<note>These are remote OFXP attachment references only; they are not local file attachments. Binary transfer requires an explicit OFXP file-transfer capability.</note>`
            : ""
          return {
            title: response.result.title,
            output: `${response.result.output}${attachmentNote}`,
            metadata: {
              ofxpAction: input.action,
              peerID,
              ...(input.rootID ? { rootID: input.rootID } : {}),
              capability,
              invocationID,
              ok: true,
              ...(attachments.length ? { remoteAttachments: attachments.length } : {}),
            },
          }
        }).pipe(Effect.catch((error: unknown) => Effect.succeed(failure(input.action, error, {
          ...(input.peerID ? { peerID: input.peerID } : {}),
          ...(input.rootID ? { rootID: input.rootID } : {}),
          ...(input.capability ? { capability: input.capability } : {}),
          ...(callInvocationID ? { invocationID: callInvocationID } : {}),
        }))))
      },
    }
  }),
)

export * as OfxpToolModule from "./ofxp"
