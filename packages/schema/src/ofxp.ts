export * as Ofxp from "./ofxp"

import { Schema } from "effect"
import { descending } from "./identifier"
import { optional, statics } from "./schema"
import { SessionID } from "./session-id"

const PEER_ID = /^ofxp_[A-Za-z0-9_-]{43}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const PAIRING_NONCE = /^[A-Za-z0-9_-]{43}$/
const REKEY_SIGNATURE = /^[A-Za-z0-9_-]{1,512}$/

export const PeerID = Schema.String.check(Schema.isPattern(PEER_ID)).pipe(Schema.brand("Ofxp.PeerID"))
export type PeerID = typeof PeerID.Type

export const RootID = Schema.String.check(Schema.isStartsWith("ofxr_")).pipe(
  Schema.brand("Ofxp.RootID"),
  statics((schema) => ({ create: () => schema.make("ofxr_" + descending()) })),
)
export type RootID = typeof RootID.Type

export const RootAlias = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,31}$/),
).pipe(Schema.brand("Ofxp.RootAlias"))
export type RootAlias = typeof RootAlias.Type

export const PublicKeyFingerprint = Schema.String.check(Schema.isPattern(FINGERPRINT)).pipe(
  Schema.brand("Ofxp.PublicKeyFingerprint"),
)
export type PublicKeyFingerprint = typeof PublicKeyFingerprint.Type

export const PairingNonce = Schema.String.check(Schema.isPattern(PAIRING_NONCE)).pipe(
  Schema.brand("Ofxp.PairingNonce"),
)
export type PairingNonce = typeof PairingNonce.Type

export const PairingID = Schema.String.check(Schema.isStartsWith("ofxp_pair_")).pipe(
  Schema.brand("Ofxp.PairingID"),
  statics((schema) => ({ create: () => schema.make("ofxp_pair_" + descending()) })),
)
export type PairingID = typeof PairingID.Type

export const InvocationID = Schema.String.check(Schema.isStartsWith("ofxi_")).pipe(
  Schema.brand("Ofxp.InvocationID"),
  statics((schema) => ({ create: () => schema.make("ofxi_" + descending()) })),
)
export type InvocationID = typeof InvocationID.Type

export const TraceID = Schema.String.check(Schema.isStartsWith("ofxt_")).pipe(
  Schema.brand("Ofxp.TraceID"),
  statics((schema) => ({ create: () => schema.make("ofxt_" + descending()) })),
)
export type TraceID = typeof TraceID.Type

export const InvocationSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("session"),
    sessionID: SessionID,
  }),
  Schema.Struct({
    kind: Schema.Literal("external"),
    principal: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
]).annotate({ identifier: "Ofxp.InvocationSource" })
export type InvocationSource = typeof InvocationSource.Type

export const ProtocolVersion = Schema.Literal(1).annotate({ identifier: "Ofxp.ProtocolVersion" })
export type ProtocolVersion = typeof ProtocolVersion.Type

export const Plane = Schema.Literals(["augmentation", "supervision", "delegation", "messaging"]).annotate({
  identifier: "Ofxp.Plane",
})
export type Plane = typeof Plane.Type

export const CapabilityClass = Schema.Literals([
  "read",
  "write",
  "git",
  "process",
  "integrations",
  "browser",
  "filesReceive",
  "filesSend",
  "automation",
  "messaging",
  "sessionSupervision",
  "requestSupervision",
  "delegation",
  "nestedDelegation",
]).annotate({ identifier: "Ofxp.CapabilityClass" })
export type CapabilityClass = typeof CapabilityClass.Type

export const CapabilityID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
).annotate({ identifier: "Ofxp.CapabilityID" })
export type CapabilityID = typeof CapabilityID.Type

export const CommitClass = Schema.Literals([
  "safe_read",
  "idempotent_mutation",
  "non_idempotent_mutation",
  "durable_start",
]).annotate({ identifier: "Ofxp.CommitClass" })
export type CommitClass = typeof CommitClass.Type

export const ReceiptState = Schema.Literals(["admitted", "started", "committed", "failed", "cancelled"]).annotate({
  identifier: "Ofxp.ReceiptState",
})
export type ReceiptState = typeof ReceiptState.Type

export const MutationClass = Schema.Literals(["none", "idempotent", "non-idempotent", "durable-start"]).annotate({
  identifier: "Ofxp.MutationClass",
})
export type MutationClass = typeof MutationClass.Type

export const RekeyState = Schema.Literals(["stable", "required"]).annotate({ identifier: "Ofxp.RekeyState" })
export type RekeyState = typeof RekeyState.Type

export const SessionSupervision = Schema.Literals(["none", "approved-roots"]).annotate({
  identifier: "Ofxp.SessionSupervision",
})
export type SessionSupervision = typeof SessionSupervision.Type

export const Delegation = Schema.Literals(["disabled", "spawn"]).annotate({ identifier: "Ofxp.Delegation" })
export type Delegation = typeof Delegation.Type

export interface Grant extends Schema.Schema.Type<typeof Grant> {}
export const Grant = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
  git: Schema.Boolean,
  process: Schema.Boolean,
  integrations: Schema.Boolean,
  browser: Schema.Boolean,
  filesReceive: Schema.Boolean,
  filesSend: Schema.Boolean,
  automation: Schema.Boolean,
  messaging: Schema.Boolean,
  sessionSupervision: SessionSupervision,
  requestSupervision: Schema.Boolean,
  delegation: Delegation,
  nestedDelegation: Schema.Boolean,
}).annotate({ identifier: "Ofxp.Grant" })

export const DENY_GRANT: Grant = Object.freeze({
  read: false,
  write: false,
  git: false,
  process: false,
  integrations: false,
  browser: false,
  filesReceive: false,
  filesSend: false,
  automation: false,
  messaging: false,
  sessionSupervision: "none",
  requestSupervision: false,
  delegation: "disabled",
  nestedDelegation: false,
})

export interface PeerIdentity extends Schema.Schema.Type<typeof PeerIdentity> {}
export const PeerIdentity = Schema.Struct({
  id: PeerID,
  realmID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  publicKeySpki: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  fingerprint: PublicKeyFingerprint,
}).annotate({ identifier: "Ofxp.PeerIdentity" })

export interface PeerInfo extends Schema.Schema.Type<typeof PeerInfo> {}
export const PeerInfo = Schema.Struct({
  id: PeerID,
  realmID: Schema.String,
  label: Schema.String,
  fingerprint: PublicKeyFingerprint,
  rekeyState: RekeyState,
  pairedAt: Schema.Int,
  lastSeenAt: optional(Schema.Int),
  revokedAt: optional(Schema.Int),
  grantRevision: Schema.Int,
  grantExpiresAt: optional(Schema.Int),
}).annotate({ identifier: "Ofxp.PeerInfo" })

export interface PublicRoot extends Schema.Schema.Type<typeof PublicRoot> {}
export const PublicRoot = Schema.Struct({
  id: RootID,
  alias: RootAlias,
  available: Schema.Boolean,
  source: Schema.Literals(["manual", "project"]),
  approvedAt: Schema.Int,
}).annotate({ identifier: "Ofxp.PublicRoot" })

export interface RekeyProof extends Schema.Schema.Type<typeof RekeyProof> {}
export const RekeyProof = Schema.Struct({
  algorithm: Schema.Literal("ecdsa-p256-sha256-v1"),
  previousPeerID: PeerID,
  next: PeerIdentity,
  nonce: PairingNonce,
  issuedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  signature: Schema.String.check(Schema.isPattern(REKEY_SIGNATURE)),
}).annotate({ identifier: "Ofxp.RekeyProof" })

export interface Hello extends Schema.Schema.Type<typeof Hello> {}
export const Hello = Schema.Struct({
  protocolMin: ProtocolVersion,
  protocolMax: ProtocolVersion,
  peerID: PeerID,
  realmID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  openforkVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  surfaceFingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  features: Schema.Struct({
    pairing: Schema.Boolean,
    capabilityExchange: Schema.Boolean,
    messaging: Schema.Boolean,
    supervision: Schema.Boolean,
    delegation: Schema.Boolean,
  }),
}).annotate({ identifier: "Ofxp.Hello" })

export interface PairingOffer extends Schema.Schema.Type<typeof PairingOffer> {}
export const PairingOffer = Schema.Struct({
  pairingID: PairingID,
  initiator: PeerIdentity,
  initiatorNonce: PairingNonce,
  expiresAt: Schema.Int,
  rekeyProof: optional(RekeyProof),
}).annotate({ identifier: "Ofxp.PairingOffer" })

export interface PairingAnswer extends Schema.Schema.Type<typeof PairingAnswer> {}
export const PairingAnswer = Schema.Struct({
  pairingID: PairingID,
  initiatorPeerID: PeerID,
  responder: PeerIdentity,
  initiatorNonce: PairingNonce,
  responderNonce: PairingNonce,
  expiresAt: Schema.Int,
  rekeyProof: optional(RekeyProof),
}).annotate({ identifier: "Ofxp.PairingAnswer" })

export interface InvocationContext extends Schema.Schema.Type<typeof InvocationContext> {}
export const InvocationContext = Schema.Struct({
  invocationID: InvocationID,
  traceID: TraceID,
  parentInvocationID: optional(InvocationID),
  sourcePeerID: PeerID,
  // v1 compatibility: existing OpenFork callers send sourceSessionID. New
  // external principals (for example OXP) use source instead of fabricating a
  // Session. Receivers must require at least one of these provenance fields.
  sourceSessionID: optional(SessionID),
  source: optional(InvocationSource),
  plane: Plane,
  hopCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16)),
}).annotate({ identifier: "Ofxp.InvocationContext" })

export interface CapabilityCall extends Schema.Schema.Type<typeof CapabilityCall> {}
export const CapabilityCall = Schema.Struct({
  context: InvocationContext,
  rootID: optional(RootID),
  capability: CapabilityID,
  contract: Schema.String.check(Schema.isPattern(/^broker-v1:[0-9a-f]{24}$/)),
  args: Schema.Unknown,
}).annotate({ identifier: "Ofxp.CapabilityCall" })

export interface CapabilityCatalogRow extends Schema.Schema.Type<typeof CapabilityCatalogRow> {}
export const CapabilityCatalogRow = Schema.Struct({
  id: CapabilityID,
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  authority: CapabilityClass,
  workspaceTier: Schema.Literal(3),
  mutation: MutationClass,
  commitClass: CommitClass,
  requiresRoot: Schema.Boolean,
}).annotate({ identifier: "Ofxp.CapabilityCatalogRow" })

export const CapabilityListRequest = Schema.Struct({
  rootID: optional(RootID),
}).annotate({ identifier: "Ofxp.CapabilityListRequest" })

export const CapabilityDescribeRequest = Schema.Struct({
  capability: CapabilityID,
}).annotate({ identifier: "Ofxp.CapabilityDescribeRequest" })

export interface CapabilityDescriptor extends Schema.Schema.Type<typeof CapabilityDescriptor> {}
export const CapabilityDescriptor = Schema.Struct({
  protocol: Schema.Literal("broker-descriptor-v1"),
  broker: Schema.Literal("ofxp.capability"),
  target: CapabilityID,
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  inputSchema: Schema.Unknown,
  contract: Schema.String.check(Schema.isPattern(/^broker-v1:[0-9a-f]{24}$/)),
  invocation: Schema.Struct({
    action: Schema.Literal("call"),
    targetField: Schema.Literal("capability"),
    target: CapabilityID,
    contractField: Schema.Literal("contract"),
    argsField: Schema.Literal("args"),
  }),
  rules: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(8)),
  capability: CapabilityCatalogRow,
}).annotate({ identifier: "Ofxp.CapabilityDescriptor" })

export interface CapabilityResult extends Schema.Schema.Type<typeof CapabilityResult> {}
export const CapabilityAttachment = Schema.Struct({
  kind: Schema.Literals(["file", "resource"]),
  handle: Schema.String.check(Schema.isMaxLength(4096)),
  mediaType: optional(Schema.String.check(Schema.isMaxLength(256))),
  name: optional(Schema.String.check(Schema.isMaxLength(512))),
  bytes: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "Ofxp.CapabilityAttachment" })

export const CapabilityResult = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(512)),
  output: Schema.String.check(Schema.isMaxLength(128 * 1024)),
  attachments: optional(Schema.Array(CapabilityAttachment).check(Schema.isMaxLength(16))),
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "Ofxp.CapabilityResult" })

export const ErrorCode = Schema.Literals([
  "PROTOCOL_MISMATCH",
  "IDENTITY_MISMATCH",
  "PAIRING_REQUIRED",
  "PEER_REVOKED",
  "AUTHORITY_DENIED",
  "ROOT_REQUIRED",
  "ROOT_NOT_FOUND",
  "ROOT_CHANGED",
  "STALE_GRANT",
  "STALE_CONTRACT",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "CANCELLED",
  "DEPENDENCY_UNAVAILABLE",
  "AMBIGUOUS_COMMIT",
  "INTERNAL",
]).annotate({ identifier: "Ofxp.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type

export interface ErrorEnvelope extends Schema.Schema.Type<typeof ErrorEnvelope> {}
export const ErrorEnvelope = Schema.Struct({
  code: ErrorCode,
  message: Schema.String.check(Schema.isMaxLength(1024)),
  invocationID: optional(InvocationID),
  retryable: Schema.Boolean,
  retryAfterMs: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "Ofxp.ErrorEnvelope" })

export interface InvocationReceipt extends Schema.Schema.Type<typeof InvocationReceipt> {}
export const InvocationReceipt = Schema.Struct({
  invocationID: InvocationID,
  sourcePeerID: PeerID,
  operation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  commitClass: CommitClass,
  state: ReceiptState,
  targetRef: optional(Schema.String.check(Schema.isMaxLength(4096))),
  resultDigest: optional(Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))),
  createdAt: Schema.Int,
  settledAt: optional(Schema.Int),
}).annotate({ identifier: "Ofxp.InvocationReceipt" })

export const ReceiptGetRequest = Schema.Struct({
  invocationID: InvocationID,
}).annotate({ identifier: "Ofxp.ReceiptGetRequest" })

export interface FailureResponse extends Schema.Schema.Type<typeof FailureResponse> {}
export const FailureResponse = Schema.Struct({ ok: Schema.Literal(false), error: ErrorEnvelope }).annotate({
  identifier: "Ofxp.FailureResponse",
})

export const RootListResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), roots: Schema.Array(PublicRoot).check(Schema.isMaxLength(128)) }),
  FailureResponse,
]).annotate({ identifier: "Ofxp.RootListResponse" })
export type RootListResponse = typeof RootListResponse.Type

export const CapabilityListResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    capabilities: Schema.Array(CapabilityCatalogRow).check(Schema.isMaxLength(64)),
  }),
  FailureResponse,
]).annotate({ identifier: "Ofxp.CapabilityListResponse" })
export type CapabilityListResponse = typeof CapabilityListResponse.Type

export const CapabilityDescribeResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), descriptor: CapabilityDescriptor }),
  FailureResponse,
]).annotate({ identifier: "Ofxp.CapabilityDescribeResponse" })
export type CapabilityDescribeResponse = typeof CapabilityDescribeResponse.Type

export const ReceiptGetResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), receipt: InvocationReceipt }),
  FailureResponse,
]).annotate({ identifier: "Ofxp.ReceiptGetResponse" })
export type ReceiptGetResponse = typeof ReceiptGetResponse.Type

export const CapabilityResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: CapabilityResult }),
  FailureResponse,
]).annotate({ identifier: "Ofxp.CapabilityResponse" })
export type CapabilityResponse = typeof CapabilityResponse.Type

