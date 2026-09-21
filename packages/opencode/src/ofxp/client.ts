export * as OfxpClient from "./client"

import { Effect, Schema } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { OfxpConnectionManager } from "./connection-manager"

export class PeerUnavailableError extends Schema.TaggedErrorClass<PeerUnavailableError>()("OfxpClient.PeerUnavailableError", {
  peerID: Ofxp.PeerID,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("OfxpClient.ProtocolError", {
  peerID: Ofxp.PeerID,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export type Error = PeerUnavailableError | ProtocolError

interface InvocationBase {
  readonly peerID: Ofxp.PeerID
  readonly invocationID?: Ofxp.InvocationID
  readonly rootID?: Ofxp.RootID
  readonly capability: Ofxp.CapabilityID
  readonly contract: string
  readonly args: unknown
  readonly traceID?: Ofxp.TraceID
  readonly parentInvocationID?: Ofxp.InvocationID
  readonly hopCount?: number
}

export type Invocation = InvocationBase & (
  | { readonly sourceSessionID: SessionID; readonly source?: never }
  | { readonly source: Ofxp.InvocationSource; readonly sourceSessionID?: never }
)

export type EndpointResolver = (peerID: Ofxp.PeerID) => readonly OfxpConnectionManager.TargetEndpoint[]

function trustError(record: OfxpPeer.Record) {
  if (record.info.revokedAt !== undefined) {
    return new ProtocolError({ peerID: record.info.id, detail: `OFXP peer is revoked: ${record.info.id}` })
  }
  if (record.info.rekeyState !== "stable") {
    return new ProtocolError({ peerID: record.info.id, detail: `OFXP peer requires re-key confirmation: ${record.info.id}` })
  }
}

/** Negotiate application compatibility exactly once for each newly pooled TLS connection. */
export async function negotiate(connection: OfxpConnectionManager.ConnectionLike, peerID: Ofxp.PeerID) {
  const raw = await connection.request<unknown>("hello")
  const remote = Schema.decodeUnknownSync(Ofxp.Hello)(raw, { onExcessProperty: "error" })
  if (remote.peerID !== peerID || remote.peerID !== connection.peer.peerID) {
    throw new Error("OFXP hello identity does not match the authenticated peer")
  }
  if (remote.protocolMin > 1 || remote.protocolMax < 1) {
    throw new Error(`OFXP protocol v1 is not supported by peer ${peerID}`)
  }
  if (!remote.features.capabilityExchange) {
    throw new Error(`OFXP peer ${peerID} does not advertise capability exchange`)
  }
}

/**
 * Outbound OFXP semantic client. This layer owns peer trust admission, endpoint
 * resolution, typed wire decoding, and invocation provenance. It deliberately
 * does not consult this machine's directional grant for the remote peer: that
 * grant controls what the peer may do here, while the remote runtime controls
 * what this machine may do there.
 */
export class Client {
  constructor(
    private readonly local: Ofxp.PeerIdentity,
    private readonly peers: OfxpPeer.Interface,
    private readonly connections: OfxpConnectionManager.Manager,
    private readonly endpoints: EndpointResolver,
  ) {}

  private request<S extends Schema.Decoder<unknown, never>>(
    peerID: Ofxp.PeerID,
    method: string,
    body: unknown,
    schema: S,
    signal?: AbortSignal,
  ): Effect.Effect<S["Type"], Error | OfxpPeer.OfxpPeerSchema.NotFoundError> {
    return Effect.gen(
      function* (this: Client) {
        const record = yield* this.peers.get(peerID)
        const denied = trustError(record)
        if (denied) return yield* denied
        const raw = yield* Effect.tryPromise({
          try: () => this.connections.request<unknown>(peerID, this.endpoints(peerID), method, body, undefined, signal),
          catch: (cause) =>
            new PeerUnavailableError({
              peerID,
              detail: `Unable to reach OFXP peer ${peerID}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
            }),
        })
        return yield* Effect.try({
          try: () => Schema.decodeUnknownSync(schema)(raw, { onExcessProperty: "error" }),
          catch: (cause) =>
            new ProtocolError({
              peerID,
              detail: `OFXP peer ${peerID} returned an invalid ${method} response: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
            }),
        })
      }.bind(this),
    )
  }

  roots(peerID: Ofxp.PeerID, signal?: AbortSignal) {
    return this.request(peerID, "root.list", undefined, Ofxp.RootListResponse, signal)
  }

  capabilities(peerID: Ofxp.PeerID, rootID?: Ofxp.RootID, signal?: AbortSignal) {
    return this.request(peerID, "capability.list", rootID ? { rootID } : {}, Ofxp.CapabilityListResponse, signal)
  }

  describe(peerID: Ofxp.PeerID, capability: Ofxp.CapabilityID, signal?: AbortSignal) {
    return this.request(peerID, "capability.describe", { capability }, Ofxp.CapabilityDescribeResponse, signal)
  }

  receipt(peerID: Ofxp.PeerID, invocationID: Ofxp.InvocationID, signal?: AbortSignal) {
    return this.request(peerID, "receipt.get", { invocationID }, Ofxp.ReceiptGetResponse, signal)
  }

  invoke(input: Invocation, signal?: AbortSignal) {
    const context: Ofxp.InvocationContext = {
      invocationID: input.invocationID ?? Ofxp.InvocationID.create(),
      traceID: input.traceID ?? Ofxp.TraceID.create(),
      ...(input.parentInvocationID ? { parentInvocationID: input.parentInvocationID } : {}),
      sourcePeerID: this.local.id,
      ...(input.sourceSessionID ? { sourceSessionID: input.sourceSessionID } : {}),
      ...(input.source ? { source: input.source } : {}),
      plane: "augmentation",
      hopCount: input.hopCount ?? 0,
    }
    const body: Ofxp.CapabilityCall = {
      context,
      ...(input.rootID ? { rootID: input.rootID } : {}),
      capability: input.capability,
      contract: input.contract,
      args: input.args,
    }
    return this.request(input.peerID, "capability.call", body, Ofxp.CapabilityResponse, signal)
  }
}
