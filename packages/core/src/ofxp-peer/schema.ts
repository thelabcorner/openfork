export * as OfxpPeerSchema from "./schema"

import { Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OfxpPeer.NotFoundError", {
  peerID: Ofxp.PeerID,
}) {
  override get message() {
    return `OFXP peer not found: ${this.peerID}`
  }
}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()("OfxpPeer.StaleRevisionError", {
  peerID: Ofxp.PeerID,
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
}) {
  override get message() {
    return `OFXP peer ${this.peerID} grant changed concurrently (expected revision ${this.expectedRevision}, current revision ${this.actualRevision}).`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("OfxpPeer.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `OFXP peer operation rejected: ${this.reason}`
  }
}

export class IdentityMismatchError extends Schema.TaggedErrorClass<IdentityMismatchError>()(
  "OfxpPeer.IdentityMismatchError",
  {
    peerID: Ofxp.PeerID,
    expectedFingerprint: Ofxp.PublicKeyFingerprint,
    actualFingerprint: Ofxp.PublicKeyFingerprint,
  },
) {
  override get message() {
    return `OFXP peer ${this.peerID} presented a different identity key (${this.actualFingerprint}; expected ${this.expectedFingerprint}).`
  }
}

export const AuthorityDenialReason = Schema.Literals([
  "peer_revoked",
  "rekey_required",
  "grant_missing",
  "grant_expired",
  "capability_denied",
  "root_required",
  "root_not_found",
  "root_changed",
]).annotate({ identifier: "OfxpPeer.AuthorityDenialReason" })
export type AuthorityDenialReason = typeof AuthorityDenialReason.Type

export class AuthorityDeniedError extends Schema.TaggedErrorClass<AuthorityDeniedError>()("OfxpPeer.AuthorityDeniedError", {
  peerID: Ofxp.PeerID,
  capability: Ofxp.CapabilityClass,
  reason: AuthorityDenialReason,
}) {
  override get message() {
    return `OFXP authority denied for ${this.peerID} (${this.capability}): ${this.reason}`
  }
}

export const PeerAccessDenialReason = Schema.Literals([
  "peer_revoked",
  "rekey_required",
  "grant_missing",
  "grant_expired",
]).annotate({ identifier: "OfxpPeer.PeerAccessDenialReason" })
export type PeerAccessDenialReason = typeof PeerAccessDenialReason.Type

export class PeerAccessDeniedError extends Schema.TaggedErrorClass<PeerAccessDeniedError>()("OfxpPeer.PeerAccessDeniedError", {
  peerID: Ofxp.PeerID,
  reason: PeerAccessDenialReason,
}) {
  override get message() {
    return `OFXP peer access denied for ${this.peerID}: ${this.reason}`
  }
}

export type Error =
  | NotFoundError
  | StaleRevisionError
  | ValidationError
  | IdentityMismatchError
  | AuthorityDeniedError
  | PeerAccessDeniedError

