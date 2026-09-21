import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpRuntime } from "@/ofxp/runtime"
import { OfxpRoot } from "@/ofxp/root"
import { RootHttpApi } from "../api"
import * as ApiError from "../errors"
import type {
  OfxpGrantPayload,
  OfxpIdentityMutationPayload,
  OfxpRevokePayload,
  OfxpRootPayload,
  OfxpServerSeedsPayload,
} from "../groups/ofxp"

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function runtimeError(error: unknown) {
  const tag = error && typeof error === "object" && "_tag" in error ? String(error._tag) : ""
  if (tag === "OfxpRuntime.ConflictError") {
    return new ApiError.ConflictError({ message: message(error), code: "ofxp_state_changed" })
  }
  if (tag === "OfxpRuntime.UnavailableError" || tag === "OfxpClient.PeerUnavailableError") {
    return new ApiError.ServiceUnavailableError({ message: message(error), service: "ofxp" })
  }
  return new ApiError.InvalidRequestError({ message: message(error), kind: "ofxp" })
}

function peerError(error: unknown, staleCode = "ofxp_stale_grant") {
  const tag = error && typeof error === "object" && "_tag" in error ? String(error._tag) : ""
  if (tag === "OfxpPeer.NotFoundError") return ApiError.notFound(message(error))
  if (tag === "OfxpPeer.StaleRevisionError") {
    return new ApiError.ConflictError({ message: message(error), code: staleCode })
  }
  if (tag === "OfxpPeer.IdentityMismatchError") {
    return new ApiError.ConflictError({ message: message(error), code: "ofxp_identity_changed" })
  }
  return new ApiError.InvalidRequestError({ message: message(error), kind: "ofxp" })
}

export const ofxpHandlers = HttpApiBuilder.group(RootHttpApi, "ofxp", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* OfxpRuntime.Service
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service

    /**
     * Tier-0/Tier-1 operator snapshot.
     * Activity is one bounded grouped ledger query for the whole page; never
     * fan out one receipt/history request per peer and never hydrate Sessions.
     */
    const state = Effect.fn("OfxpHttpApi.state")(function* () {
      const [status, candidates, connections, pairings, overview] = yield* Effect.all([
        runtime.status(),
        runtime.candidates(),
        runtime.connectionStatuses(),
        runtime.pairingPreviews(),
        peers.overview(),
      ])
      const recentActivity = yield* invocations.recentByPeer({
        sourcePeerIDs: overview.map(({ record }) => record.info.id),
        perPeerLimit: 1,
      })
      const candidateByPeer = new Map(candidates.map((candidate) => [candidate.peerID, candidate] as const))
      const connectionByPeer = new Map(connections.map((connection) => [connection.peerID, connection] as const))
      return {
        status,
        candidates: candidates.map((candidate) => ({
          peerID: candidate.peerID,
          realmID: candidate.realmID,
          openforkVersion: candidate.openforkVersion,
          protocolVersion: candidate.protocolVersion,
          pairing: candidate.pairing,
          endpointCount: candidate.instances.length,
          lastSeenAt: candidate.lastSeenAt,
        })),
        pairings: pairings.map((pairing) => ({
          pairingID: pairing.pairingID,
          peer: {
            id: pairing.peer.id,
            realmID: pairing.peer.realmID,
            label: pairing.peer.label,
            fingerprint: pairing.peer.fingerprint,
          },
          sas: pairing.sas,
          expiresAt: pairing.expiresAt,
          ...(pairing.rekeyProof
            ? {
                continuityClaim: {
                  previousPeerID: pairing.rekeyProof.previousPeerID,
                  expiresAt: pairing.rekeyProof.expiresAt,
                },
              }
            : {}),
        })),
        peers: overview.map(({ record, roots }) => {
          const candidate = candidateByPeer.get(record.info.id)
          const connection = connectionByPeer.get(record.info.id)
          return {
            info: record.info,
            grant: record.grant,
            roots: roots.map((root) => ({
              id: root.id,
              alias: root.alias,
              source: root.source,
              approvedAt: root.approvedAt,
            })),
            online: candidate !== undefined || connection !== undefined,
            ...(candidate
              ? {
                  openforkVersion: candidate.openforkVersion,
                  protocolVersion: candidate.protocolVersion,
                }
              : {}),
            ...(connection
              ? {
                  authenticatedEndpoint: {
                    host: connection.endpoint.host,
                    port: connection.endpoint.port,
                    pendingRequests: connection.pendingRequests,
                  },
                }
              : {}),
          }
        }),
        activity: recentActivity.flatMap(({ receipts }) =>
          receipts.map((item) => ({
            sourcePeerID: item.sourcePeerID,
            operation: item.operation,
            commitClass: item.commitClass,
            state: item.state,
            createdAt: item.createdAt,
            ...(item.settledAt === undefined ? {} : { settledAt: item.settledAt }),
          })),
        ),
      }
    })

    const refresh = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.andThen(state()))

    return handlers
      .handle("state", () => state())
      .handle("runtime", ({ payload }) =>
        runtime.setEnabled(payload.enabled).pipe(Effect.mapError(runtimeError), Effect.andThen(state())),
      )
      .handle("serverSeeds", ({ payload }: { payload: typeof OfxpServerSeedsPayload.Type }) =>
        runtime
          .replaceServerSeeds(payload.seeds.map((seed) => ({ ...seed, source: "server" as const })))
          .pipe(Effect.map((accepted) => ({ accepted }))),
      )
      .handle("rotateIdentity", ({ payload }: { payload: typeof OfxpIdentityMutationPayload.Type }) =>
        runtime.rotateIdentity(payload.expectedPeerID).pipe(Effect.mapError(runtimeError), Effect.andThen(state())),
      )
      .handle("finalizeIdentityRotation", ({ payload }: { payload: typeof OfxpIdentityMutationPayload.Type }) =>
        runtime
          .finalizeIdentityRotation(payload.expectedPeerID)
          .pipe(Effect.mapError(runtimeError), Effect.andThen(state())),
      )
      .handle("pair", ({ params }) => refresh(runtime.initiatePairing(params.peerID).pipe(Effect.mapError(runtimeError))))
      .handle("pairingConfirm", ({ params }) =>
        refresh(
          runtime.confirmPairing(params.pairingID).pipe(
            Effect.mapError((error) =>
              error._tag === "OfxpPeer.NotFoundError" ||
              error._tag === "OfxpPeer.IdentityMismatchError" ||
              error._tag === "OfxpPeer.ValidationError"
                ? peerError(error)
                : runtimeError(error),
            ),
          ),
        ),
      )
      .handle("pairingCancel", ({ params }) => refresh(runtime.cancelPairing(params.pairingID)))
      .handle("grant", ({ params, payload }: { params: { peerID: Parameters<typeof peers.get>[0] }; payload: typeof OfxpGrantPayload.Type }) =>
        refresh(
          peers
            .setGrant({ peerID: params.peerID, expectedRevision: payload.expectedRevision, grant: payload.grant })
            .pipe(Effect.mapError(peerError)),
        ),
      )
      .handle(
        "revoke",
        ({
          params,
          payload,
        }: {
          params: { peerID: Parameters<typeof peers.get>[0] }
          payload: typeof OfxpRevokePayload.Type
        }) =>
        refresh(
          peers.revokeFenced({ peerID: params.peerID, expectedRevision: payload.expectedRevision }).pipe(
            Effect.mapError((error) => peerError(error, "ofxp_stale_peer")),
            Effect.flatMap((removed) =>
              removed ? Effect.void : Effect.fail(ApiError.notFound(`OFXP peer not found: ${params.peerID}`)),
            ),
          ),
        ),
      )
      .handle("rootAdd", ({ params, payload }: { params: { peerID: Parameters<typeof peers.get>[0] }; payload: typeof OfxpRootPayload.Type }) =>
        refresh(
          roots
            .approve(
              params.peerID,
              payload.canonicalPath,
              payload.alias,
              payload.source ?? "manual",
              payload.expectedRevision,
            )
            .pipe(Effect.mapError((error) => peerError(error, "ofxp_stale_root"))),
        ),
      )
      .handle("rootRemove", ({ params }) =>
        refresh(
          peers.removeRoot({ peerID: params.peerID, rootID: params.rootID }).pipe(
            Effect.flatMap((removed) =>
              removed ? Effect.void : Effect.fail(ApiError.notFound(`OFXP root not found: ${params.rootID}`)),
            ),
          ),
        ),
      )
  }),
)
