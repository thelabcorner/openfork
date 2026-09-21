import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError, ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"
import { described } from "./metadata"

const root = "/ofxp"

export const OfxpPaths = {
  state: `${root}/state`,
  runtime: `${root}/runtime`,
  rotateIdentity: `${root}/runtime/rotate-identity`,
  finalizeIdentityRotation: `${root}/runtime/rotation/finalize`,
  pair: `${root}/peer/:peerID/pair`,
  pairingConfirm: `${root}/pairing/:pairingID/confirm`,
  pairing: `${root}/pairing/:pairingID`,
  grant: `${root}/peer/:peerID/grant`,
  peer: `${root}/peer/:peerID`,
  roots: `${root}/peer/:peerID/root`,
  root: `${root}/peer/:peerID/root/:rootID`,
} as const

export const OfxpRuntimeStatus = Schema.Struct({
  active: Schema.Boolean,
  peerID: Schema.optionalKey(Ofxp.PeerID),
  label: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
  discovery: Schema.Literals(["disabled", "active", "degraded"]),
  discoveryError: Schema.optionalKey(Schema.String),
  identityRotationSupported: Schema.optionalKey(Schema.Boolean),
  rotation: Schema.optionalKey(
    Schema.Struct({
      previousPeerID: Ofxp.PeerID,
      expiresAt: Schema.Int,
      expired: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "OfxpSettings.RuntimeStatus" })

export const OfxpCandidate = Schema.Struct({
  peerID: Ofxp.PeerID,
  realmID: Schema.String,
  openforkVersion: Schema.String,
  protocolVersion: Schema.Int,
  pairing: Schema.Boolean,
  endpointCount: Schema.Int,
  lastSeenAt: Schema.Int,
}).annotate({ identifier: "OfxpSettings.Candidate" })

const PairingPeer = Schema.Struct({
  id: Ofxp.PeerID,
  realmID: Schema.String,
  label: Schema.String,
  fingerprint: Ofxp.PublicKeyFingerprint,
}).annotate({ identifier: "OfxpSettings.PairingPeer" })

export const OfxpPairingPreview = Schema.Struct({
  pairingID: Ofxp.PairingID,
  peer: PairingPeer,
  sas: Schema.String,
  expiresAt: Schema.Int,
  continuityClaim: Schema.optionalKey(
    Schema.Struct({
      previousPeerID: Ofxp.PeerID,
      expiresAt: Schema.Int,
    }),
  ),
}).annotate({ identifier: "OfxpSettings.PairingPreview" })

/**
 * Settings-owned root approval metadata.
 *
 * Filesystem liveness is intentionally absent: the compact settings projection
 * must not imply that an approved path is currently reachable, and must not add
 * per-root filesystem probes to its polling path. OFXP execution revalidates the
 * canonical root at the authority boundary before every operation.
 */
export const OfxpApprovedRoot = Schema.Struct({
  id: Ofxp.RootID,
  alias: Ofxp.RootAlias,
  source: Schema.Literals(["manual", "project"]),
  approvedAt: Schema.Int,
}).annotate({ identifier: "OfxpSettings.ApprovedRoot" })

export const OfxpAuthenticatedEndpoint = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
  port: Schema.Int,
  pendingRequests: Schema.Int,
}).annotate({ identifier: "OfxpSettings.AuthenticatedEndpoint" })

export const OfxpPeerOverview = Schema.Struct({
  info: Ofxp.PeerInfo,
  grant: Ofxp.Grant,
  roots: Schema.Array(OfxpApprovedRoot),
  online: Schema.Boolean,
  openforkVersion: Schema.optionalKey(Schema.String),
  protocolVersion: Schema.optionalKey(Schema.Int),
  authenticatedEndpoint: Schema.optionalKey(OfxpAuthenticatedEndpoint),
}).annotate({ identifier: "OfxpSettings.PeerOverview" })

/**
 * Bounded Tier-0 activity row for Settings.
 *
 * Deliberately excludes invocation IDs, target references, and result/request
 * digests. Those belong to receipt diagnostics, not the default peer-control
 * surface.
 */
export const OfxpRecentActivity = Schema.Struct({
  sourcePeerID: Ofxp.PeerID,
  operation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  commitClass: Ofxp.CommitClass,
  state: Ofxp.ReceiptState,
  createdAt: Schema.Int,
  settledAt: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "OfxpSettings.RecentActivity" })

export const OfxpSettingsState = Schema.Struct({
  status: OfxpRuntimeStatus,
  candidates: Schema.Array(OfxpCandidate),
  pairings: Schema.Array(OfxpPairingPreview),
  peers: Schema.Array(OfxpPeerOverview),
  // One compact newest receipt per trusted peer. The producer caps the peer
  // input at 256, so this remains bounded without favoring globally noisy peers.
  activity: Schema.Array(OfxpRecentActivity).check(Schema.isMaxLength(256)),
}).annotate({ identifier: "OfxpSettings.State" })

export const OfxpRuntimePayload = Schema.Struct({ enabled: Schema.Boolean }).annotate({
  identifier: "OfxpSettings.RuntimePayload",
})

export const OfxpIdentityMutationPayload = Schema.Struct({
  expectedPeerID: Ofxp.PeerID,
}).annotate({ identifier: "OfxpSettings.IdentityMutationPayload" })

export const OfxpGrantPayload = Schema.Struct({
  expectedRevision: Schema.Int,
  grant: Ofxp.Grant,
}).annotate({ identifier: "OfxpSettings.GrantPayload" })

export const OfxpRevokePayload = Schema.Struct({
  expectedRevision: Schema.Int,
}).annotate({ identifier: "OfxpSettings.RevokePayload" })

export const OfxpRootPayload = Schema.Struct({
  expectedRevision: Schema.Int,
  alias: Ofxp.RootAlias,
  canonicalPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  source: Schema.optionalKey(Schema.Literals(["manual", "project"])),
}).annotate({ identifier: "OfxpSettings.RootPayload" })

/**
 * Preserve each operator error as a distinct HttpApi schema so Effect retains
 * its declared HTTP status. Wrapping these in Schema.Union collapses the union
 * to the default 500 status in both runtime responses and generated SDK types.
 */
const operatorErrors = [InvalidRequestError, ApiNotFoundError, ConflictError, ServiceUnavailableError] as const

export const OfxpApi = HttpApi.make("ofxp").add(
  HttpApiGroup.make("ofxp")
    .add(
      HttpApiEndpoint.get("state", OfxpPaths.state, {
        success: described(OfxpSettingsState, "Compact OpenFork peer-network settings state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.state",
          summary: "Get OpenFork peer network state",
          description:
            "Read the compact Tier-0/Tier-1 OFXP settings projection: local runtime state, nearby untrusted candidates, pending pairing ceremonies, trusted peers, grants, and approved root aliases. This endpoint never materializes a workspace runtime or remote capability catalog.",
        }),
      ),
      HttpApiEndpoint.patch("runtime", OfxpPaths.runtime, {
        payload: OfxpRuntimePayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.runtime",
          summary: "Enable or disable OpenFork peer networking",
          description:
            "Start or stop the narrow OFXP listener and discovery owner for this OpenFork process. Disabling OFXP stops its listener and mDNS work without affecting the ordinary OpenFork server API.",
        }),
      ),
      HttpApiEndpoint.post("rotateIdentity", OfxpPaths.rotateIdentity, {
        payload: OfxpIdentityMutationPayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.rotateIdentity",
          summary: "Rotate the local OFXP identity",
          description:
            "Atomically replace the local OFXP key, restart the narrow listener, and retain a short-lived old-key continuity proof for fresh SAS re-verification. Existing remote grants are never copied to the replacement identity.",
        }),
      ),
      HttpApiEndpoint.post("finalizeIdentityRotation", OfxpPaths.finalizeIdentityRotation, {
        payload: OfxpIdentityMutationPayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.finalizeIdentityRotation",
          summary: "Finalize the current OFXP identity rotation",
          description:
            "Explicitly discard the persisted old-key continuity journal for the current replacement identity after re-verification is complete or intentionally abandoned. The replacement key is preserved; finalization transfers no authority and is required before another rotation.",
        }),
      ),
      HttpApiEndpoint.post("pair", OfxpPaths.pair, {
        params: { peerID: Ofxp.PeerID },
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.pair",
          summary: "Begin pairing with a nearby OpenFork peer",
          description:
            "Begin an operator-controlled OFXP identity ceremony with a currently discovered candidate. Pairing establishes identity continuity only and grants no capability authority.",
        }),
      ),
      HttpApiEndpoint.post("pairingConfirm", OfxpPaths.pairingConfirm, {
        params: { pairingID: Ofxp.PairingID },
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.pairing.confirm",
          summary: "Confirm an OFXP pairing ceremony",
          description:
            "Confirm a pending pairing only after the operator has compared the displayed short authentication string on both peers. The newly trusted peer remains deny-by-default.",
        }),
      ),
      HttpApiEndpoint.delete("pairingCancel", OfxpPaths.pairing, {
        params: { pairingID: Ofxp.PairingID },
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.pairing.cancel",
          summary: "Cancel an OFXP pairing ceremony",
        }),
      ),
      HttpApiEndpoint.patch("grant", OfxpPaths.grant, {
        params: { peerID: Ofxp.PeerID },
        payload: OfxpGrantPayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.peer.grant",
          summary: "Update a trusted peer grant",
          description:
            "Replace one trusted peer's directional inbound grant using optimistic revision fencing. This operator surface changes authority; model-facing OFXP tools cannot call it.",
        }),
      ),
      HttpApiEndpoint.delete("revoke", OfxpPaths.peer, {
        params: { peerID: Ofxp.PeerID },
        payload: OfxpRevokePayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.peer.revoke",
          summary: "Revoke a trusted OpenFork peer",
          description: "Revoke peer trust immediately. Re-pairing later does not resurrect the peer's previous grants or roots.",
        }),
      ),
      HttpApiEndpoint.post("rootAdd", OfxpPaths.roots, {
        params: { peerID: Ofxp.PeerID },
        payload: OfxpRootPayload,
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.peer.root.add",
          summary: "Approve a local root for a trusted peer",
          description:
            "Approve one explicit local directory for a trusted peer. The canonical host path is validated locally and is never returned in the public root projection.",
        }),
      ),
      HttpApiEndpoint.delete("rootRemove", OfxpPaths.root, {
        params: { peerID: Ofxp.PeerID, rootID: Ofxp.RootID },
        success: OfxpSettingsState,
        error: operatorErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "ofxp.peer.root.remove",
          summary: "Remove an approved peer root",
        }),
      ),
    )
    .middleware(Authorization),
)
