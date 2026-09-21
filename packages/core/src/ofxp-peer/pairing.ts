export * as OfxpPairing from "./pairing"

import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpIdentity } from "./identity"

export const TTL_MS = 90_000
export const MAX_PENDING = 32
export const MAX_TOMBSTONES = 256

type InitiatorPending = {
  readonly role: "initiator"
  readonly startedAt: number
  readonly offer: Ofxp.PairingOffer
  remote?: Ofxp.PeerIdentity
  remoteRekeyProof?: Ofxp.RekeyProof
  sas?: string
}

type ResponderPending = {
  readonly role: "responder"
  readonly startedAt: number
  readonly offer: Ofxp.PairingOffer
  readonly answer: Ofxp.PairingAnswer
  readonly remote: Ofxp.PeerIdentity
  readonly sas: string
}

type Pending = InitiatorPending | ResponderPending

export type Preview = {
  readonly pairingID: Ofxp.PairingID
  readonly peer: Ofxp.PeerIdentity
  readonly sas: string
  readonly expiresAt: number
  readonly rekeyProof?: Ofxp.RekeyProof
}

export type Confirmation = {
  readonly peer: Ofxp.PeerIdentity
  /**
   * Local ceremony start time. Never transmitted on the wire.
   *
   * The runtime compares this against durable trust-generation timestamps so a
   * ceremony that began before revoke/re-pair cannot repair newer trust.
   */
  readonly startedAt: number
  readonly rekeyProof?: Ofxp.RekeyProof
}

function validation(message: string): never {
  throw new Error(`OFXP pairing rejected: ${message}`)
}

export class Coordinator {
  private readonly pending = new Map<Ofxp.PairingID, Pending>()
  private readonly consumed = new Map<Ofxp.PairingID, number>()

  constructor(readonly local: Ofxp.PeerIdentity) {
    OfxpIdentity.validatePeerIdentity(local)
  }

  private prune(now: number) {
    for (const [id, entry] of this.pending) {
      const expiresAt = entry.role === "initiator" ? entry.offer.expiresAt : entry.answer.expiresAt
      if (expiresAt <= now) this.pending.delete(id)
    }
    for (const [id, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(id)
  }

  private reserve(now: number) {
    this.prune(now)
    if (this.pending.size < MAX_PENDING) return
    const oldest = [...this.pending.entries()].sort((a, b) => {
      const aExpires = a[1].role === "initiator" ? a[1].offer.expiresAt : a[1].answer.expiresAt
      const bExpires = b[1].role === "initiator" ? b[1].offer.expiresAt : b[1].answer.expiresAt
      return aExpires - bExpires || a[0].localeCompare(b[0])
    })[0]
    if (oldest) this.pending.delete(oldest[0])
  }

  private tombstone(id: Ofxp.PairingID, expiresAt: number) {
    this.consumed.set(id, expiresAt)
    while (this.consumed.size > MAX_TOMBSTONES) this.consumed.delete(this.consumed.keys().next().value!)
  }

  begin(now = Date.now(), rekeyProof?: Ofxp.RekeyProof): Ofxp.PairingOffer {
    this.reserve(now)
    if (rekeyProof) {
      const next = OfxpIdentity.validatePeerIdentity(rekeyProof.next)
      if (
        next.id !== this.local.id ||
        next.realmID !== this.local.realmID ||
        next.label !== this.local.label ||
        next.publicKeySpki !== this.local.publicKeySpki ||
        next.fingerprint !== this.local.fingerprint
      ) {
        validation("re-key proof does not describe the initiating identity")
      }
      if (rekeyProof.previousPeerID === this.local.id) validation("re-key proof does not replace the initiating identity")
      if (rekeyProof.expiresAt <= now) validation("re-key proof expired")
    }
    const offer: Ofxp.PairingOffer = {
      pairingID: Ofxp.PairingID.create(),
      initiator: this.local,
      initiatorNonce: OfxpIdentity.createPairingNonce(),
      expiresAt: now + TTL_MS,
      ...(rekeyProof ? { rekeyProof } : {}),
    }
    this.pending.set(offer.pairingID, { role: "initiator", startedAt: now, offer })
    return offer
  }

  acceptOffer(
    offer: Ofxp.PairingOffer,
    now = Date.now(),
    localRekeyProof?: Ofxp.RekeyProof,
  ): { readonly answer: Ofxp.PairingAnswer; readonly preview: Preview } {
    this.reserve(now)
    const initiator = OfxpIdentity.validatePeerIdentity(offer.initiator)
    if (offer.expiresAt <= now) validation("offer expired")
    if (offer.expiresAt > now + TTL_MS) validation("offer expiry is outside the allowed window")
    if (initiator.id === this.local.id) validation("cannot pair an OpenFork peer with itself")
    if (this.consumed.has(offer.pairingID)) validation("pairing ID was already consumed")
    if (this.pending.has(offer.pairingID)) validation("pairing ID is already active")
    if (offer.rekeyProof) {
      const next = OfxpIdentity.validatePeerIdentity(offer.rekeyProof.next)
      if (
        next.id !== initiator.id ||
        next.realmID !== initiator.realmID ||
        next.label !== initiator.label ||
        next.publicKeySpki !== initiator.publicKeySpki ||
        next.fingerprint !== initiator.fingerprint
      ) {
        validation("re-key proof does not describe the pairing initiator")
      }
      if (offer.rekeyProof.previousPeerID === initiator.id) validation("re-key proof does not replace the pairing initiator")
      if (offer.rekeyProof.expiresAt <= now) validation("re-key proof expired")
    }
    if (localRekeyProof) {
      const next = OfxpIdentity.validatePeerIdentity(localRekeyProof.next)
      if (
        next.id !== this.local.id ||
        next.realmID !== this.local.realmID ||
        next.label !== this.local.label ||
        next.publicKeySpki !== this.local.publicKeySpki ||
        next.fingerprint !== this.local.fingerprint
      ) {
        validation("re-key proof does not describe the responding identity")
      }
      if (localRekeyProof.previousPeerID === this.local.id) validation("re-key proof does not replace the responding identity")
      if (localRekeyProof.expiresAt <= now) validation("re-key proof expired")
    }

    const responderNonce = OfxpIdentity.createPairingNonce()
    const expiresAt = Math.min(
      offer.expiresAt,
      offer.rekeyProof?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      localRekeyProof?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      now + TTL_MS,
    )
    const answer: Ofxp.PairingAnswer = {
      pairingID: offer.pairingID,
      initiatorPeerID: initiator.id,
      responder: this.local,
      initiatorNonce: offer.initiatorNonce,
      responderNonce,
      expiresAt,
      ...(localRekeyProof ? { rekeyProof: localRekeyProof } : {}),
    }
    const sas = OfxpIdentity.pairingSas({
      initiatorPeerID: initiator.id,
      responderPeerID: this.local.id,
      initiatorNonce: offer.initiatorNonce,
      responderNonce,
    })
    const remote = { ...initiator }
    this.pending.set(offer.pairingID, { role: "responder", startedAt: now, offer, answer, remote, sas })
    return {
      answer,
      preview: {
        pairingID: offer.pairingID,
        peer: remote,
        sas,
        expiresAt,
        ...(offer.rekeyProof ? { rekeyProof: offer.rekeyProof } : {}),
      },
    }
  }

  acceptAnswer(answer: Ofxp.PairingAnswer, now = Date.now()): Preview {
    this.prune(now)
    if (this.consumed.has(answer.pairingID)) validation("pairing ID was already consumed")
    const entry = this.pending.get(answer.pairingID)
    if (!entry || entry.role !== "initiator") validation("unknown or already-consumed pairing")
    if (entry.offer.expiresAt <= now || answer.expiresAt <= now) {
      this.pending.delete(answer.pairingID)
      validation("pairing expired")
    }
    if (answer.expiresAt > entry.offer.expiresAt) validation("answer extends the initiator expiry")
    if (answer.initiatorPeerID !== this.local.id) validation("answer targets a different initiator")
    if (answer.initiatorNonce !== entry.offer.initiatorNonce) validation("answer does not bind the initiator nonce")
    const responder = OfxpIdentity.validatePeerIdentity(answer.responder)
    if (responder.id === this.local.id) validation("cannot pair an OpenFork peer with itself")
    if (answer.rekeyProof) {
      const next = OfxpIdentity.validatePeerIdentity(answer.rekeyProof.next)
      if (
        next.id !== responder.id ||
        next.realmID !== responder.realmID ||
        next.label !== responder.label ||
        next.publicKeySpki !== responder.publicKeySpki ||
        next.fingerprint !== responder.fingerprint
      ) {
        validation("re-key proof does not describe the pairing responder")
      }
      if (answer.rekeyProof.previousPeerID === responder.id) validation("re-key proof does not replace the pairing responder")
      if (answer.rekeyProof.expiresAt <= now) validation("re-key proof expired")
    }

    const sas = OfxpIdentity.pairingSas({
      initiatorPeerID: this.local.id,
      responderPeerID: responder.id,
      initiatorNonce: answer.initiatorNonce,
      responderNonce: answer.responderNonce,
    })
    entry.remote = { ...responder }
    entry.remoteRekeyProof = answer.rekeyProof
    entry.sas = sas
    return {
      pairingID: answer.pairingID,
      peer: entry.remote,
      sas,
      expiresAt: answer.expiresAt,
      ...(answer.rekeyProof ? { rekeyProof: answer.rekeyProof } : {}),
    }
  }

  /**
   * Called only by an operator-authorized UI/CLI path after comparing the SAS.
   * Returning the identity does not grant capabilities; the caller may persist
   * peer trust and directional grants independently.
   */
  confirmWithMetadata(pairingID: Ofxp.PairingID, now = Date.now()): Confirmation {
    this.prune(now)
    const entry = this.pending.get(pairingID)
    if (!entry) validation("unknown, expired, or already-consumed pairing")
    const remote = entry.role === "responder" ? entry.remote : entry.remote
    const sas = entry.role === "responder" ? entry.sas : entry.sas
    if (!remote || !sas) validation("pairing transcript is incomplete")
    this.pending.delete(pairingID)
    const expiresAt = entry.role === "responder" ? entry.answer.expiresAt : entry.offer.expiresAt
    this.tombstone(pairingID, expiresAt)
    const rekeyProof = entry.role === "responder" ? entry.offer.rekeyProof : entry.remoteRekeyProof
    return { peer: remote, startedAt: entry.startedAt, ...(rekeyProof ? { rekeyProof } : {}) }
  }

  confirm(pairingID: Ofxp.PairingID, now = Date.now()): Ofxp.PeerIdentity {
    return this.confirmWithMetadata(pairingID, now).peer
  }

  preview(pairingID: Ofxp.PairingID, now = Date.now()): Preview | undefined {
    this.prune(now)
    const entry = this.pending.get(pairingID)
    if (!entry) return
    const remote = entry.role === "responder" ? entry.remote : entry.remote
    const sas = entry.role === "responder" ? entry.sas : entry.sas
    if (!remote || !sas) return
    return {
      pairingID,
      peer: remote,
      sas,
      expiresAt: entry.role === "responder" ? entry.answer.expiresAt : entry.offer.expiresAt,
      ...(entry.role === "responder"
        ? entry.offer.rekeyProof
          ? { rekeyProof: entry.offer.rekeyProof }
          : {}
        : entry.remoteRekeyProof
          ? { rekeyProof: entry.remoteRekeyProof }
          : {}),
    }
  }

  previews(now = Date.now()): readonly Preview[] {
    this.prune(now)
    const result: Preview[] = []
    for (const [pairingID, entry] of this.pending) {
      const remote = entry.role === "responder" ? entry.remote : entry.remote
      const sas = entry.role === "responder" ? entry.sas : entry.sas
      if (!remote || !sas) continue
      result.push({
        pairingID,
        peer: remote,
        sas,
        expiresAt: entry.role === "responder" ? entry.answer.expiresAt : entry.offer.expiresAt,
        ...(entry.role === "responder"
          ? entry.offer.rekeyProof
            ? { rekeyProof: entry.offer.rekeyProof }
            : {}
          : entry.remoteRekeyProof
            ? { rekeyProof: entry.remoteRekeyProof }
            : {}),
      })
    }
    return result.sort((a, b) => a.expiresAt - b.expiresAt || a.pairingID.localeCompare(b.pairingID))
  }

  cancel(pairingID: Ofxp.PairingID) {
    const entry = this.pending.get(pairingID)
    if (!entry) return false
    this.pending.delete(pairingID)
    this.tombstone(pairingID, entry.role === "responder" ? entry.answer.expiresAt : entry.offer.expiresAt)
    return true
  }

  /**
   * Best-effort immediate cleanup for completed local ceremonies involving one
   * peer. In-flight initiator offers do not yet know the authenticated remote
   * identity and therefore rely on the runtime's startedAt generation fence at
   * confirmation.
   */
  cancelPeer(peerID: Ofxp.PeerID, now = Date.now()) {
    this.prune(now)
    let cancelled = 0
    for (const [pairingID, entry] of this.pending) {
      const remote = entry.remote
      if (!remote || remote.id !== peerID) continue
      this.pending.delete(pairingID)
      this.tombstone(pairingID, entry.role === "responder" ? entry.answer.expiresAt : entry.offer.expiresAt)
      cancelled++
    }
    return cancelled
  }

  size(now = Date.now()) {
    this.prune(now)
    return this.pending.size
  }
}

