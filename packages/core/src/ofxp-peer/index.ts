export * as OfxpPeer from "."

import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option } from "effect"
import { isAbsolute } from "node:path"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { AbsolutePath } from "../schema"
import { OfxpIdentity } from "./identity"
import { OfxpRekey } from "./rekey"
import { OfxpPeerSchema } from "./schema"
import { OfxpPeerGrantTable, OfxpPeerRootTable, OfxpPeerTable } from "./sql"

export interface Record {
  readonly info: Ofxp.PeerInfo
  readonly publicKeySpki: string
  readonly grant: Ofxp.Grant
}

export interface Overview {
  readonly record: Record
  readonly roots: ReadonlyArray<Ofxp.PublicRoot>
}

export interface TrustInput {
  readonly identity: Ofxp.PeerIdentity
  readonly now?: number
}

export interface RekeyTrustInput {
  readonly proof: Ofxp.RekeyProof
  readonly now?: number
}

export interface SetGrantInput {
  readonly peerID: Ofxp.PeerID
  readonly expectedRevision: number
  readonly grant: Ofxp.Grant
  /**
   * Grant lifetime replacement semantics.
   * Omit to preserve the currently fenced expiry; pass null only when the
   * caller explicitly intends to make the grant unbounded.
   */
  readonly expiresAt?: number | null
  readonly now?: number
}

export interface RevokeFencedInput {
  readonly peerID: Ofxp.PeerID
  readonly expectedRevision: number
  readonly now?: number
}

export interface ApproveRootInput {
  readonly peerID: Ofxp.PeerID
  /**
   * Operator-facing callers should fence root approval to the trust/authority
   * generation they rendered. Omit only for trusted in-process callers that do
   * not originate from a staleable operator snapshot.
   */
  readonly expectedGrantRevision?: number
  readonly rootID?: Ofxp.RootID
  readonly alias: string
  readonly canonicalPath: string
  readonly identityFingerprint?: string
  readonly source?: "manual" | "project"
  readonly now?: number
}

export interface AuthorizeInput {
  readonly peerID: Ofxp.PeerID
  readonly capability: Ofxp.CapabilityClass
  readonly rootID?: Ofxp.RootID
  /**
   * Require an approved root even when the authority class is normally global
   * (for example browser visual artifacts). This may only add root scope; it
   * never disables the inherent root requirement of filesystem authorities.
   */
  readonly requireRoot?: boolean
  readonly expectedGrantRevision?: number
  readonly now?: number
}

export interface Authorization {
  readonly peerID: Ofxp.PeerID
  readonly capability: Ofxp.CapabilityClass
  readonly grantRevision: number
  readonly grantExpiresAt?: number
  readonly root?: {
    readonly id: Ofxp.RootID
    readonly alias: Ofxp.RootAlias
    readonly canonicalPath: AbsolutePath
    readonly identityFingerprint?: string
  }
}

export type Change =
  | { readonly peerID: Ofxp.PeerID; readonly kind: "trusted" }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "revoked" }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "rekey-required" }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "grant-updated" }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "root-upserted"; readonly rootID: Ofxp.RootID }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "root-removed"; readonly rootID: Ofxp.RootID }
  | { readonly peerID: Ofxp.PeerID; readonly kind: "authority-changed" }

export type ChangeListener = (change: Change) => void

export interface Interface {
  readonly trust: (input: TrustInput) => Effect.Effect<Record, OfxpPeerSchema.ValidationError | OfxpPeerSchema.IdentityMismatchError>
  readonly rekeyTrust: (
    input: RekeyTrustInput,
  ) => Effect.Effect<Record, OfxpPeerSchema.NotFoundError | OfxpPeerSchema.ValidationError>
  readonly get: (peerID: Ofxp.PeerID) => Effect.Effect<Record, OfxpPeerSchema.NotFoundError>
  readonly access: (
    peerID: Ofxp.PeerID,
    now?: number,
  ) => Effect.Effect<Record, OfxpPeerSchema.NotFoundError | OfxpPeerSchema.PeerAccessDeniedError>
  readonly list: (options?: { readonly includeRevoked?: boolean }) => Effect.Effect<ReadonlyArray<Record>>
  /**
   * Compact settings projection for all active peers. This is intentionally
   * batch-backed so dense peer UIs do not turn into one root query per row.
   */
  readonly overview: () => Effect.Effect<ReadonlyArray<Overview>>
  readonly revoke: (peerID: Ofxp.PeerID, now?: number) => Effect.Effect<boolean>
  readonly revokeFenced: (
    input: RevokeFencedInput,
  ) => Effect.Effect<boolean, OfxpPeerSchema.NotFoundError | OfxpPeerSchema.StaleRevisionError>
  readonly markSeen: (peerID: Ofxp.PeerID, now?: number) => Effect.Effect<boolean>
  readonly requireRekey: (peerID: Ofxp.PeerID, now?: number) => Effect.Effect<boolean>
  readonly setGrant: (
    input: SetGrantInput,
  ) => Effect.Effect<Record, OfxpPeerSchema.NotFoundError | OfxpPeerSchema.StaleRevisionError | OfxpPeerSchema.ValidationError>
  readonly roots: (peerID: Ofxp.PeerID) => Effect.Effect<ReadonlyArray<Ofxp.PublicRoot>, OfxpPeerSchema.NotFoundError>
  readonly approveRoot: (
    input: ApproveRootInput,
  ) => Effect.Effect<
    Ofxp.PublicRoot,
    OfxpPeerSchema.NotFoundError | OfxpPeerSchema.StaleRevisionError | OfxpPeerSchema.ValidationError
  >
  readonly removeRoot: (input: { readonly peerID: Ofxp.PeerID; readonly rootID: Ofxp.RootID }) => Effect.Effect<boolean>
  readonly authorize: (
    input: AuthorizeInput,
  ) => Effect.Effect<
    Authorization,
    OfxpPeerSchema.NotFoundError | OfxpPeerSchema.StaleRevisionError | OfxpPeerSchema.AuthorityDeniedError
  >
  /**
   * Process-global authority-change signal. Delivery is synchronous and
   * best-effort after the durable trust mutation commits; listener failures are
   * isolated and cannot roll back the trust store mutation.
   */
  readonly subscribe: (listener: ChangeListener) => () => void
  /**
   * Reconcile durable peer authority generations written by sibling processes.
   * Production subscribers drive this automatically through one bounded poller;
   * the explicit method exists for deterministic ownership/integration tests.
   */
  readonly syncExternalChanges: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/OfxpPeer") {}
export const AUTHORITY_POLL_MS = 250

function peerInfo(
  peer: typeof OfxpPeerTable.$inferSelect,
  grant: typeof OfxpPeerGrantTable.$inferSelect | undefined,
): Ofxp.PeerInfo {
  return {
    id: peer.id,
    realmID: peer.realm_id,
    label: peer.label,
    fingerprint: peer.public_key_fingerprint,
    rekeyState: peer.rekey_state,
    pairedAt: peer.paired_at,
    ...(peer.last_seen_at === null ? {} : { lastSeenAt: peer.last_seen_at }),
    ...(peer.revoked_at === null ? {} : { revokedAt: peer.revoked_at }),
    grantRevision: grant?.revision ?? 0,
    ...(grant?.expires_at === null || grant?.expires_at === undefined ? {} : { grantExpiresAt: grant.expires_at }),
  }
}

function recordOf(
  peer: typeof OfxpPeerTable.$inferSelect,
  grant: typeof OfxpPeerGrantTable.$inferSelect | undefined,
): Record {
  return {
    info: peerInfo(peer, grant),
    publicKeySpki: peer.public_key_spki,
    // Grants are JSON rows and may predate newly-added deny-by-default fields.
    // Normalize at the durable owner so every consumer sees a complete policy.
    grant: { ...Ofxp.DENY_GRANT, ...(grant?.grant ?? {}) },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const listeners = new Set<ChangeListener>()
    const authorityEpochs = new Map<Ofxp.PeerID, number>(
      (
        yield* readDb
          .select({ peerID: OfxpPeerTable.id, epoch: OfxpPeerTable.authority_epoch })
          .from(OfxpPeerTable)
          .all()
          .pipe(Effect.orDie)
      ).map((row) => [row.peerID, row.epoch] as const),
    )
    let authorityPoller: ReturnType<typeof setInterval> | undefined
    let authorityPollInFlight = false

    const notify = (change: Change) => {
      for (const listener of [...listeners]) {
        try {
          listener(change)
        } catch {
          // Authority mutations remain authoritative even if an observer is
          // already tearing down. Resource owners fail closed independently.
        }
      }
    }

    const syncExternalChanges = Effect.fn("OfxpPeer.syncExternalChanges")(function* () {
      const rows = yield* readDb
        .select({ peerID: OfxpPeerTable.id, epoch: OfxpPeerTable.authority_epoch })
        .from(OfxpPeerTable)
        .orderBy(asc(OfxpPeerTable.id))
        .all()
        .pipe(Effect.orDie)
      let changed = 0
      for (const row of rows) {
        if (authorityEpochs.get(row.peerID) === row.epoch) continue
        authorityEpochs.set(row.peerID, row.epoch)
        changed++
        notify({ peerID: row.peerID, kind: "authority-changed" })
      }
      return changed
    })

    const rememberAuthorityEpoch = Effect.fnUntraced(function* (peerID: Ofxp.PeerID) {
      const row = yield* readDb
        .select({ epoch: OfxpPeerTable.authority_epoch })
        .from(OfxpPeerTable)
        .where(eq(OfxpPeerTable.id, peerID))
        .get()
        .pipe(Effect.orDie)
      if (row) authorityEpochs.set(peerID, row.epoch)
    })

    const stopAuthorityPoller = () => {
      if (!authorityPoller) return
      clearInterval(authorityPoller)
      authorityPoller = undefined
    }

    const startAuthorityPoller = () => {
      if (authorityPoller) return
      authorityPoller = setInterval(() => {
        if (authorityPollInFlight) return
        authorityPollInFlight = true
        void Effect.runPromise(
          syncExternalChanges().pipe(
            Effect.catchCause((cause) => Effect.logError("OFXP authority generation poll failed", { cause })),
          ),
        ).finally(() => {
          authorityPollInFlight = false
        })
      }, AUTHORITY_POLL_MS)
      authorityPoller.unref?.()
    }

    const subscribe: Interface["subscribe"] = (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) startAuthorityPoller()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopAuthorityPoller()
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(stopAuthorityPoller))

    const rootFingerprint = Effect.fnUntraced(function* (canonicalPath: string) {
      const info = yield* fs.stat(canonicalPath).pipe(
        Effect.mapError(() => new OfxpPeerSchema.ValidationError({ reason: "OFXP approved root is not available" })),
      )
      if (info.type !== "Directory") {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "OFXP approved root must be a directory" })
      }
      const inode = Number(Option.getOrElse(info.ino, () => 0))
      return inode > 0 ? `inode:${inode}` : undefined
    })

    const read = Effect.fn("OfxpPeer.read")(function* (peerID: Ofxp.PeerID) {
      const peer = yield* readDb.select().from(OfxpPeerTable).where(eq(OfxpPeerTable.id, peerID)).get().pipe(Effect.orDie)
      if (!peer) return yield* new OfxpPeerSchema.NotFoundError({ peerID })
      const grant = yield* readDb
        .select()
        .from(OfxpPeerGrantTable)
        .where(eq(OfxpPeerGrantTable.peer_id, peerID))
        .get()
        .pipe(Effect.orDie)
      return recordOf(peer, grant)
    })

    const trust = Effect.fn("OfxpPeer.trust")(function* (input: TrustInput) {
      const now = input.now ?? Date.now()
      if (input.identity.publicKeySpki.length > 4096) {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "peer public identity key is too large" })
      }
      const normalized = yield* Effect.try({
        try: () => OfxpIdentity.validatePeerIdentity(input.identity),
        catch: (cause) => new OfxpPeerSchema.ValidationError({ reason: cause instanceof Error ? cause.message : String(cause) }),
      })
      const label = normalized.label.trim()
      const realmID = normalized.realmID.trim()
      if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "peer label is invalid" })
      }
      if (!realmID || realmID.length > 256 || /[\x00-\x1f\x7f]/.test(realmID)) {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "peer realm ID is invalid" })
      }

      const existing = yield* db
        .select()
        .from(OfxpPeerTable)
        .where(eq(OfxpPeerTable.id, normalized.id))
        .get()
        .pipe(Effect.orDie)
      if (existing && existing.public_key_fingerprint !== normalized.fingerprint) {
        return yield* new OfxpPeerSchema.IdentityMismatchError({
          peerID: normalized.id,
          expectedFingerprint: existing.public_key_fingerprint,
          actualFingerprint: normalized.fingerprint,
        })
      }

      const existingGrant = existing
        ? yield* db
            .select()
            .from(OfxpPeerGrantTable)
            .where(eq(OfxpPeerGrantTable.peer_id, normalized.id))
            .get()
            .pipe(Effect.orDie)
        : undefined
      const repairing = existing?.revoked_at !== null && existing?.revoked_at !== undefined
      const pairingAt = repairing ? now : (existing?.paired_at ?? now)

      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(OfxpPeerTable)
              .values({
                id: normalized.id,
                realm_id: realmID,
                label,
                public_key_spki: normalized.publicKeySpki,
                public_key_fingerprint: normalized.fingerprint,
                rekey_state: "stable",
                paired_at: pairingAt,
                last_seen_at: existing?.last_seen_at ?? null,
                revoked_at: null,
                authority_epoch: 1,
                time_created: existing?.time_created ?? now,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: OfxpPeerTable.id,
                set: {
                  realm_id: realmID,
                  label,
                  public_key_spki: normalized.publicKeySpki,
                  public_key_fingerprint: normalized.fingerprint,
                  rekey_state: "stable",
                  paired_at: pairingAt,
                  revoked_at: null,
                  authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`,
                  time_updated: now,
                },
              })
              .run()
            if (repairing) {
              // Revocation is a hard authority boundary. Re-pairing proves the
              // identity again; it must never resurrect the old capability/root
              // grant merely because the peer key is the same.
              yield* tx.delete(OfxpPeerRootTable).where(eq(OfxpPeerRootTable.peer_id, normalized.id)).run()
              yield* tx
                .insert(OfxpPeerGrantTable)
                .values({
                  peer_id: normalized.id,
                  revision: (existingGrant?.revision ?? 0) + 1,
                  grant: { ...Ofxp.DENY_GRANT },
                  expires_at: null,
                  time_updated: now,
                })
                .onConflictDoUpdate({
                  target: OfxpPeerGrantTable.peer_id,
                  set: {
                    revision: (existingGrant?.revision ?? 0) + 1,
                    grant: { ...Ofxp.DENY_GRANT },
                    expires_at: null,
                    time_updated: now,
                  },
                })
                .run()
            } else {
              yield* tx
                .insert(OfxpPeerGrantTable)
                .values({ peer_id: normalized.id, revision: 1, grant: { ...Ofxp.DENY_GRANT }, expires_at: null, time_updated: now })
                .onConflictDoNothing()
                .run()
            }
          }),
        )
        .pipe(Effect.orDie)
      yield* rememberAuthorityEpoch(normalized.id)
      const result = yield* read(normalized.id).pipe(Effect.orDie)
      notify({ peerID: normalized.id, kind: "trusted" })
      return result
    })

    /**
     * Commit an operator-confirmed old-key -> new-key trust transition.
     *
     * The proof establishes cryptographic continuity only. Callers must invoke
     * this from a fresh SAS-confirmation boundary. The old peer is revoked
     * atomically with creation of a new deny-by-default peer. Grants and roots
     * deliberately remain attached only to the revoked old identity.
     */
    const rekeyTrust = Effect.fn("OfxpPeer.rekeyTrust")(function* (input: RekeyTrustInput) {
      const now = input.now ?? Date.now()
      const previousPeerID = input.proof.previousPeerID
      const outcome = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const previous = yield* tx
                .select()
                .from(OfxpPeerTable)
                .where(eq(OfxpPeerTable.id, previousPeerID))
                .get()
                .pipe(Effect.orDie)
              if (!previous) return { _tag: "missing" as const }
              if (previous.revoked_at !== null) return { _tag: "revoked" as const }

              const next = yield* Effect.try({
                try: () =>
                  OfxpRekey.verify({
                    proof: input.proof,
                    previous: {
                      peerID: previous.id,
                      realmID: previous.realm_id,
                      publicKeySpki: previous.public_key_spki,
                    },
                    now,
                  }),
                catch: (cause) =>
                  new OfxpPeerSchema.ValidationError({
                    reason: cause instanceof Error ? cause.message : String(cause),
                  }),
              })

              const existingNext = yield* tx
                .select({ id: OfxpPeerTable.id })
                .from(OfxpPeerTable)
                .where(eq(OfxpPeerTable.id, next.id))
                .get()
                .pipe(Effect.orDie)
              if (existingNext) return { _tag: "exists" as const }

              yield* tx
                .update(OfxpPeerTable)
                .set({
                  revoked_at: now,
                  rekey_state: "required",
                  authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`,
                  time_updated: now,
                })
                .where(and(eq(OfxpPeerTable.id, previous.id), isNull(OfxpPeerTable.revoked_at)))
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .insert(OfxpPeerTable)
                .values({
                  id: next.id,
                  realm_id: next.realmID,
                  label: next.label,
                  public_key_spki: next.publicKeySpki,
                  public_key_fingerprint: next.fingerprint,
                  rekey_state: "stable",
                  paired_at: now,
                  last_seen_at: null,
                  revoked_at: null,
                  authority_epoch: 1,
                  time_created: now,
                  time_updated: now,
                })
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .insert(OfxpPeerGrantTable)
                .values({
                  peer_id: next.id,
                  revision: 1,
                  grant: { ...Ofxp.DENY_GRANT },
                  expires_at: null,
                  time_updated: now,
                })
                .run()
                .pipe(Effect.orDie)
              return { _tag: "ok" as const, next }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))

      if (outcome._tag === "missing") return yield* new OfxpPeerSchema.NotFoundError({ peerID: previousPeerID })
      if (outcome._tag === "revoked") {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "previous OFXP peer trust is already revoked" })
      }
      if (outcome._tag === "exists") {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "replacement OFXP peer identity is already trusted" })
      }

      yield* rememberAuthorityEpoch(previousPeerID)
      yield* rememberAuthorityEpoch(outcome.next.id)
      const result = yield* read(outcome.next.id).pipe(Effect.orDie)
      notify({ peerID: previousPeerID, kind: "revoked" })
      notify({ peerID: outcome.next.id, kind: "trusted" })
      return result
    })

    const list = Effect.fn("OfxpPeer.list")(function* (options?: { readonly includeRevoked?: boolean }) {
      const peers = yield* readDb
        .select()
        .from(OfxpPeerTable)
        .where(options?.includeRevoked ? undefined : isNull(OfxpPeerTable.revoked_at))
        .orderBy(asc(OfxpPeerTable.label), asc(OfxpPeerTable.id))
        .all()
        .pipe(Effect.orDie)
      if (peers.length === 0) return []
      const grants = yield* readDb.select().from(OfxpPeerGrantTable).all().pipe(Effect.orDie)
      const byPeer = new Map(grants.map((grant) => [grant.peer_id, grant] as const))
      return peers.map((peer) => recordOf(peer, byPeer.get(peer.id)))
    })

    const overview = Effect.fn("OfxpPeer.overview")(function* () {
      const [peerRows, grantRows, rootRows] = yield* Effect.all([
        readDb
          .select()
          .from(OfxpPeerTable)
          .where(isNull(OfxpPeerTable.revoked_at))
          .orderBy(asc(OfxpPeerTable.label), asc(OfxpPeerTable.id))
          .all()
          .pipe(Effect.orDie),
        readDb.select().from(OfxpPeerGrantTable).all().pipe(Effect.orDie),
        readDb
          .select()
          .from(OfxpPeerRootTable)
          .orderBy(asc(OfxpPeerRootTable.alias), asc(OfxpPeerRootTable.root_id))
          .all()
          .pipe(Effect.orDie),
      ])
      const grants = new Map(grantRows.map((grant) => [grant.peer_id, grant] as const))
      const roots = new Map<Ofxp.PeerID, Ofxp.PublicRoot[]>()
      for (const root of rootRows) {
        const value: Ofxp.PublicRoot = {
          id: root.root_id,
          alias: root.alias,
          available: true,
          source: root.source,
          approvedAt: root.approved_at,
        }
        const bucket = roots.get(root.peer_id)
        if (bucket) bucket.push(value)
        else roots.set(root.peer_id, [value])
      }
      return peerRows.map((peer) => ({
        record: recordOf(peer, grants.get(peer.id)),
        roots: roots.get(peer.id) ?? [],
      }))
    })

    const access = Effect.fn("OfxpPeer.access")(function* (peerID: Ofxp.PeerID, now = Date.now()) {
      const record = yield* read(peerID)
      if (record.info.revokedAt !== undefined) {
        return yield* new OfxpPeerSchema.PeerAccessDeniedError({ peerID, reason: "peer_revoked" })
      }
      if (record.info.rekeyState !== "stable") {
        return yield* new OfxpPeerSchema.PeerAccessDeniedError({ peerID, reason: "rekey_required" })
      }
      if (record.info.grantRevision < 1) {
        return yield* new OfxpPeerSchema.PeerAccessDeniedError({ peerID, reason: "grant_missing" })
      }
      if (record.info.grantExpiresAt !== undefined && record.info.grantExpiresAt <= now) {
        return yield* new OfxpPeerSchema.PeerAccessDeniedError({ peerID, reason: "grant_expired" })
      }
      return record
    })

    const revoke = Effect.fn("OfxpPeer.revoke")(function* (peerID: Ofxp.PeerID, now = Date.now()) {
      const updated = yield* db
        .update(OfxpPeerTable)
        .set({ revoked_at: now, authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`, time_updated: now })
        .where(eq(OfxpPeerTable.id, peerID))
        .returning({ id: OfxpPeerTable.id })
        .get()
        .pipe(Effect.orDie)
      if (updated) {
        yield* rememberAuthorityEpoch(peerID)
        notify({ peerID, kind: "revoked" })
      }
      return !!updated
    })

    /**
     * Revoke one exact trust/authority generation.
     *
     * Re-pairing a revoked same-key identity increments its grant revision, so
     * checking that revision inside the same IMMEDIATE transaction as the
     * revoke prevents a stale operator from revoking a newer repaired trust
     * generation it never observed.
     */
    const revokeFenced = Effect.fn("OfxpPeer.revokeFenced")(function* (input: RevokeFencedInput) {
      const now = input.now ?? Date.now()
      const outcome = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const peer = yield* tx
                .select({ id: OfxpPeerTable.id, revokedAt: OfxpPeerTable.revoked_at })
                .from(OfxpPeerTable)
                .where(eq(OfxpPeerTable.id, input.peerID))
                .get()
                .pipe(Effect.orDie)
              if (!peer) return { _tag: "missing" as const }

              const grant = yield* tx
                .select({ revision: OfxpPeerGrantTable.revision })
                .from(OfxpPeerGrantTable)
                .where(eq(OfxpPeerGrantTable.peer_id, input.peerID))
                .get()
                .pipe(Effect.orDie)
              const actualRevision = grant?.revision ?? 0
              if (actualRevision !== input.expectedRevision) {
                return { _tag: "stale" as const, actualRevision }
              }
              if (peer.revokedAt !== null) return { _tag: "already-revoked" as const }

              const updated = yield* tx
                .update(OfxpPeerTable)
                .set({
                  revoked_at: now,
                  authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`,
                  time_updated: now,
                })
                .where(and(eq(OfxpPeerTable.id, input.peerID), isNull(OfxpPeerTable.revoked_at)))
                .returning({ id: OfxpPeerTable.id })
                .get()
                .pipe(Effect.orDie)
              return updated ? ({ _tag: "revoked" as const } as const) : ({ _tag: "already-revoked" as const } as const)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))

      if (outcome._tag === "missing") return yield* new OfxpPeerSchema.NotFoundError({ peerID: input.peerID })
      if (outcome._tag === "stale") {
        return yield* new OfxpPeerSchema.StaleRevisionError({
          peerID: input.peerID,
          expectedRevision: input.expectedRevision,
          actualRevision: outcome.actualRevision,
        })
      }
      if (outcome._tag === "revoked") {
        yield* rememberAuthorityEpoch(input.peerID)
        notify({ peerID: input.peerID, kind: "revoked" })
      }
      return outcome._tag === "revoked"
    })

    const markSeen = Effect.fn("OfxpPeer.markSeen")(function* (peerID: Ofxp.PeerID, now = Date.now()) {
      const updated = yield* db
        .update(OfxpPeerTable)
        .set({ last_seen_at: now, time_updated: now })
        .where(and(eq(OfxpPeerTable.id, peerID), isNull(OfxpPeerTable.revoked_at)))
        .returning({ id: OfxpPeerTable.id })
        .get()
        .pipe(Effect.orDie)
      return !!updated
    })

    const requireRekey = Effect.fn("OfxpPeer.requireRekey")(function* (peerID: Ofxp.PeerID, now = Date.now()) {
      const updated = yield* db
        .update(OfxpPeerTable)
        .set({
          rekey_state: "required",
          authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`,
          time_updated: now,
        })
        .where(eq(OfxpPeerTable.id, peerID))
        .returning({ id: OfxpPeerTable.id })
        .get()
        .pipe(Effect.orDie)
      if (updated) {
        yield* rememberAuthorityEpoch(peerID)
        notify({ peerID, kind: "rekey-required" })
      }
      return !!updated
    })

    const setGrant = Effect.fn("OfxpPeer.setGrant")(function* (input: SetGrantInput) {
      const now = input.now ?? Date.now()
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existingPeer = yield* tx
                .select({ id: OfxpPeerTable.id, revokedAt: OfxpPeerTable.revoked_at })
                .from(OfxpPeerTable)
                .where(eq(OfxpPeerTable.id, input.peerID))
                .get()
                .pipe(Effect.orDie)
              if (!existingPeer) return yield* new OfxpPeerSchema.NotFoundError({ peerID: input.peerID })
              if (existingPeer.revokedAt != null) {
                return yield* new OfxpPeerSchema.ValidationError({
                  reason: "cannot grant authority to a revoked OFXP peer",
                })
              }

              const updated = yield* tx
                .update(OfxpPeerGrantTable)
                .set({
                  grant: { ...input.grant },
                  ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
                  revision: input.expectedRevision + 1,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(OfxpPeerGrantTable.peer_id, input.peerID),
                    eq(OfxpPeerGrantTable.revision, input.expectedRevision),
                  ),
                )
                .returning({ revision: OfxpPeerGrantTable.revision })
                .get()
                .pipe(Effect.orDie)
              if (!updated) {
                const current = yield* tx
                  .select({ revision: OfxpPeerGrantTable.revision })
                  .from(OfxpPeerGrantTable)
                  .where(eq(OfxpPeerGrantTable.peer_id, input.peerID))
                  .get()
                  .pipe(Effect.orDie)
                return yield* new OfxpPeerSchema.StaleRevisionError({
                  peerID: input.peerID,
                  expectedRevision: input.expectedRevision,
                  actualRevision: current?.revision ?? 0,
                })
              }

              yield* tx
                .update(OfxpPeerTable)
                .set({ authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`, time_updated: now })
                .where(eq(OfxpPeerTable.id, input.peerID))
                .run()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* rememberAuthorityEpoch(input.peerID)
      const result = yield* read(input.peerID)
      notify({ peerID: input.peerID, kind: "grant-updated" })
      return result
    })

    const roots = Effect.fn("OfxpPeer.roots")(function* (peerID: Ofxp.PeerID) {
      const peer = yield* readDb
        .select({ id: OfxpPeerTable.id, revokedAt: OfxpPeerTable.revoked_at })
        .from(OfxpPeerTable)
        .where(eq(OfxpPeerTable.id, peerID))
        .get()
        .pipe(Effect.orDie)
      if (!peer) return yield* new OfxpPeerSchema.NotFoundError({ peerID })
      const values = yield* readDb
        .select()
        .from(OfxpPeerRootTable)
        .where(eq(OfxpPeerRootTable.peer_id, peerID))
        .orderBy(asc(OfxpPeerRootTable.alias), asc(OfxpPeerRootTable.root_id))
        .all()
        .pipe(Effect.orDie)
      return values.map(
        (root): Ofxp.PublicRoot => ({
          id: root.root_id,
          alias: root.alias,
          available: true,
          source: root.source,
          approvedAt: root.approved_at,
        }),
      )
    })

    /**
     * Durable root-approval owner.
     *
     * Canonical-path retries must preserve the existing public root ID, while
     * aliases remain unique per peer. Reconcile both identities inside one
     * IMMEDIATE transaction so concurrent settings/API approvals cannot leak a
     * raw SQLite uniqueness failure or manufacture duplicate authority roots.
     */
    const approveRoot = Effect.fn("OfxpPeer.approveRoot")(function* (input: ApproveRootInput) {
      const peer = yield* readDb
        .select({ id: OfxpPeerTable.id, revokedAt: OfxpPeerTable.revoked_at })
        .from(OfxpPeerTable)
        .where(eq(OfxpPeerTable.id, input.peerID))
        .get()
        .pipe(Effect.orDie)
      if (!peer) return yield* new OfxpPeerSchema.NotFoundError({ peerID: input.peerID })
      if (peer.revokedAt != null) {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "cannot approve roots for a revoked OFXP peer" })
      }
      if (!isAbsolute(input.canonicalPath)) {
        return yield* new OfxpPeerSchema.ValidationError({ reason: "OFXP approved root must be an absolute local path" })
      }
      const canonicalPath = yield* fs.realPath(input.canonicalPath).pipe(
        Effect.mapError(() => new OfxpPeerSchema.ValidationError({ reason: "OFXP approved root is not available" })),
      )
      const fingerprint = input.identityFingerprint ?? (yield* rootFingerprint(canonicalPath))
      const alias = yield* Effect.try({
        try: () => Ofxp.RootAlias.make(input.alias.trim().toLowerCase()),
        catch: () => new OfxpPeerSchema.ValidationError({ reason: "OFXP approved root alias is invalid" }),
      })
      const approvedAt = input.now ?? Date.now()
      const source = input.source ?? "manual"
      const absolutePath = AbsolutePath.make(canonicalPath)
      const rootID = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const currentPeer = yield* tx
                .select({ id: OfxpPeerTable.id, revokedAt: OfxpPeerTable.revoked_at })
                .from(OfxpPeerTable)
                .where(eq(OfxpPeerTable.id, input.peerID))
                .get()
                .pipe(Effect.orDie)
              if (!currentPeer) return yield* new OfxpPeerSchema.NotFoundError({ peerID: input.peerID })
              if (currentPeer.revokedAt != null) {
                return yield* new OfxpPeerSchema.ValidationError({ reason: "cannot approve roots for a revoked OFXP peer" })
              }
              if (input.expectedGrantRevision !== undefined) {
                const currentGrant = yield* tx
                  .select({ revision: OfxpPeerGrantTable.revision })
                  .from(OfxpPeerGrantTable)
                  .where(eq(OfxpPeerGrantTable.peer_id, input.peerID))
                  .get()
                  .pipe(Effect.orDie)
                const actualRevision = currentGrant?.revision ?? 0
                if (actualRevision !== input.expectedGrantRevision) {
                  return yield* new OfxpPeerSchema.StaleRevisionError({
                    peerID: input.peerID,
                    expectedRevision: input.expectedGrantRevision,
                    actualRevision,
                  })
                }
              }

              const byPath = yield* tx
                .select()
                .from(OfxpPeerRootTable)
                .where(and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.canonical_path, absolutePath)))
                .get()
                .pipe(Effect.orDie)
              const byAlias = yield* tx
                .select()
                .from(OfxpPeerRootTable)
                .where(and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.alias, alias)))
                .get()
                .pipe(Effect.orDie)
              const byID = input.rootID
                ? yield* tx
                    .select()
                    .from(OfxpPeerRootTable)
                    .where(
                      and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.root_id, input.rootID)),
                    )
                    .get()
                    .pipe(Effect.orDie)
                : undefined

              if (byPath && input.rootID && byPath.root_id !== input.rootID) {
                return yield* new OfxpPeerSchema.ValidationError({
                  reason: "OFXP canonical root is already approved with a different root ID",
                })
              }

              const existing = byPath ?? byID
              if (byAlias && (!existing || byAlias.root_id !== existing.root_id)) {
                return yield* new OfxpPeerSchema.ValidationError({
                  reason: "OFXP approved root alias '" + alias + "' is already assigned to a different root",
                })
              }

              const id = existing?.root_id ?? input.rootID ?? Ofxp.RootID.create()
              if (existing) {
                yield* tx
                  .update(OfxpPeerRootTable)
                  .set({
                    alias,
                    canonical_path: absolutePath,
                    identity_fingerprint: fingerprint ?? null,
                    source,
                    approved_at: approvedAt,
                  })
                  .where(and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.root_id, id)))
                  .run()
                  .pipe(Effect.orDie)
              } else {
                yield* tx
                  .insert(OfxpPeerRootTable)
                  .values({
                    peer_id: input.peerID,
                    root_id: id,
                    alias,
                    canonical_path: absolutePath,
                    identity_fingerprint: fingerprint ?? null,
                    source,
                    approved_at: approvedAt,
                  })
                  .run()
                  .pipe(Effect.orDie)
              }
              yield* tx
                .update(OfxpPeerTable)
                .set({ authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`, time_updated: approvedAt })
                .where(eq(OfxpPeerTable.id, input.peerID))
                .run()
                .pipe(Effect.orDie)
              return id
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* rememberAuthorityEpoch(input.peerID)
      const result = { id: rootID, alias, available: true, source, approvedAt } as const
      notify({ peerID: input.peerID, kind: "root-upserted", rootID })
      return result
    })

    const removeRoot = Effect.fn("OfxpPeer.removeRoot")(function* (input: { peerID: Ofxp.PeerID; rootID: Ofxp.RootID }) {
      const now = Date.now()
      const removed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const removed = yield* tx
                .delete(OfxpPeerRootTable)
                .where(and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.root_id, input.rootID)))
                .returning({ rootID: OfxpPeerRootTable.root_id })
                .get()
                .pipe(Effect.orDie)
              if (!removed) return undefined
              yield* tx
                .update(OfxpPeerTable)
                .set({ authority_epoch: sql`${OfxpPeerTable.authority_epoch} + 1`, time_updated: now })
                .where(eq(OfxpPeerTable.id, input.peerID))
                .run()
                .pipe(Effect.orDie)
              return removed
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (removed) {
        yield* rememberAuthorityEpoch(input.peerID)
        notify({ peerID: input.peerID, kind: "root-removed", rootID: input.rootID })
      }
      return !!removed
    })

    // Root scope is inherent only for authorities whose effects/read-set are
    // filesystem/worktree anchored. Global integrations and browser control are
    // independently grantable; individual operations may still impose a root
    // (for example browser visual artifacts) at their adapter boundary.
    const rootRequired = (capability: Ofxp.CapabilityClass) =>
      capability !== "messaging" && capability !== "integrations" && capability !== "browser"

    const allowed = (grant: Ofxp.Grant, capability: Ofxp.CapabilityClass) => {
      switch (capability) {
        case "read":
        case "write":
        case "git":
        case "process":
        case "integrations":
        case "browser":
        case "filesReceive":
        case "filesSend":
        case "automation":
        case "messaging":
        case "requestSupervision":
        case "nestedDelegation":
          return grant[capability]
        case "sessionSupervision":
          return grant.sessionSupervision === "approved-roots"
        case "delegation":
          return grant.delegation === "spawn"
      }
    }

    const authorize = Effect.fn("OfxpPeer.authorize")(function* (input: AuthorizeInput) {
      const now = input.now ?? Date.now()
      const peer = yield* readDb
        .select()
        .from(OfxpPeerTable)
        .where(eq(OfxpPeerTable.id, input.peerID))
        .get()
        .pipe(Effect.orDie)
      if (!peer) return yield* new OfxpPeerSchema.NotFoundError({ peerID: input.peerID })
      if (peer.revoked_at !== null) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "peer_revoked",
        })
      }
      if (peer.rekey_state !== "stable") {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "rekey_required",
        })
      }
      const grant = yield* readDb
        .select()
        .from(OfxpPeerGrantTable)
        .where(eq(OfxpPeerGrantTable.peer_id, input.peerID))
        .get()
        .pipe(Effect.orDie)
      if (!grant) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "grant_missing",
        })
      }
      if (input.expectedGrantRevision !== undefined && grant.revision !== input.expectedGrantRevision) {
        return yield* new OfxpPeerSchema.StaleRevisionError({
          peerID: input.peerID,
          expectedRevision: input.expectedGrantRevision,
          actualRevision: grant.revision,
        })
      }
      if (grant.expires_at !== null && grant.expires_at <= now) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "grant_expired",
        })
      }
      if (!allowed(grant.grant, input.capability)) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "capability_denied",
        })
      }
      const needsRoot = rootRequired(input.capability) || input.requireRoot === true
      if (!needsRoot) {
        return {
          peerID: input.peerID,
          capability: input.capability,
          grantRevision: grant.revision,
          ...(grant.expires_at === null ? {} : { grantExpiresAt: grant.expires_at }),
        }
      }
      if (!input.rootID) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "root_required",
        })
      }
      const root = yield* readDb
        .select()
        .from(OfxpPeerRootTable)
        .where(and(eq(OfxpPeerRootTable.peer_id, input.peerID), eq(OfxpPeerRootTable.root_id, input.rootID)))
        .get()
        .pipe(Effect.orDie)
      if (!root) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "root_not_found",
        })
      }
      const verifiedPath = yield* fs.realPath(root.canonical_path).pipe(
        Effect.mapError(
          () =>
            new OfxpPeerSchema.AuthorityDeniedError({
              peerID: input.peerID,
              capability: input.capability,
              reason: "root_not_found",
            }),
        ),
      )
      if (FSUtil.normalizePath(verifiedPath) !== FSUtil.normalizePath(root.canonical_path)) {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "root_changed",
        })
      }
      const info = yield* fs.stat(verifiedPath).pipe(
        Effect.mapError(
          () =>
            new OfxpPeerSchema.AuthorityDeniedError({
              peerID: input.peerID,
              capability: input.capability,
              reason: "root_not_found",
            }),
        ),
      )
      if (info.type !== "Directory") {
        return yield* new OfxpPeerSchema.AuthorityDeniedError({
          peerID: input.peerID,
          capability: input.capability,
          reason: "root_changed",
        })
      }
      if (root.identity_fingerprint) {
        const inode = Number(Option.getOrElse(info.ino, () => 0))
        if (inode > 0 && root.identity_fingerprint !== `inode:${inode}`) {
          return yield* new OfxpPeerSchema.AuthorityDeniedError({
            peerID: input.peerID,
            capability: input.capability,
            reason: "root_changed",
          })
        }
      }
      return {
        peerID: input.peerID,
        capability: input.capability,
        grantRevision: grant.revision,
        ...(grant.expires_at === null ? {} : { grantExpiresAt: grant.expires_at }),
        root: {
          id: root.root_id,
          alias: root.alias,
          canonicalPath: root.canonical_path,
          ...(root.identity_fingerprint === null ? {} : { identityFingerprint: root.identity_fingerprint }),
        },
      }
    })

    return Service.of({
      trust,
      rekeyTrust,
      get: read,
      access,
      list,
      overview,
      revoke,
      revokeFenced,
      markSeen,
      requireRekey,
      setGrant,
      roots,
      approveRoot,
      removeRoot,
      authorize,
      subscribe,
      syncExternalChanges,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node] })

export { OfxpPeerSchema }

