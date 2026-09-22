export * as OfxpRuntime from "./runtime"

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Context, Effect, Exit, Layer, Schema, SynchronizedRef } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OfxpIdentity, type KeyPair } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpIdentityStore } from "@opencode-ai/core/ofxp-peer/identity-store"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { serviceRealmID } from "@/server/shared/instance-identity"
import { OfxpCertificate } from "./certificate"
import { OfxpCapability } from "./capability"
import { OfxpClient } from "./client"
import { OfxpConnectionManager } from "./connection-manager"
import { OfxpDiscovery } from "./discovery"
import { canFinalizeIdentityRotation, canRotateIdentity, type RotationPolicyConflict } from "./rotation-policy"
import { OfxpTransport } from "./transport"

const SURFACE_DESCRIPTOR = Object.freeze({
  wire: 1,
  bootstrap: ["hello", "pair.offer"],
  application: ["root.list", "capability.list", "capability.describe", "capability.call", "receipt.get"],
  planes: ["augmentation", "supervision", "delegation", "messaging"],
})

export const SURFACE_FINGERPRINT = `sha256:${createHash("sha256")
  .update(JSON.stringify(SURFACE_DESCRIPTOR), "utf8")
  .digest("hex")}`

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("OfxpRuntime.UnavailableError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class PairingError extends Schema.TaggedErrorClass<PairingError>()("OfxpRuntime.PairingError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("OfxpRuntime.ConflictError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export type Error = UnavailableError | PairingError | ConflictError | OfxpClient.Error

export type DiscoveryState = "disabled" | "active" | "degraded"

export interface Status {
  readonly active: boolean
  readonly peerID?: Ofxp.PeerID
  readonly label?: string
  readonly port?: number
  readonly discovery: DiscoveryState
  readonly discoveryError?: string
  readonly identityRotationSupported?: boolean
  readonly rotation?: {
    readonly previousPeerID: Ofxp.PeerID
    readonly expiresAt: number
    readonly expired: boolean
  }
}

export type BootstrapProjection =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly peerID: Ofxp.PeerID
      readonly fingerprint: Ofxp.PublicKeyFingerprint
      readonly protocolMin: number
      readonly protocolMax: number
      readonly pairing: true
      readonly endpointHints: readonly [{ readonly port: number }]
      readonly publicOrigin?: string
    }

export interface StartInput {
  readonly host?: string
  readonly port?: number
  readonly label?: string
  readonly discovery?: boolean
  readonly identityStore?: OfxpIdentityStore.Store
}

export type CapabilityInvocation = OfxpClient.Invocation

type Active = {
  readonly key: KeyPair
  readonly identity: Ofxp.PeerIdentity
  readonly identityStore: OfxpIdentityStore.Store
  readonly continuityProof?: Ofxp.RekeyProof
  readonly material: Awaited<ReturnType<typeof OfxpCertificate.issue>>
  readonly pairing: OfxpPairing.Coordinator
  readonly connections: OfxpConnectionManager.Manager
  readonly client: OfxpClient.Client
  readonly endpoint: OfxpTransport.Endpoint
  readonly directory: OfxpDiscovery.Directory
  readonly mdns?: OfxpDiscovery.Mdns
  readonly discovery: DiscoveryState
  readonly discoveryError?: string
  readonly listenHost: string
  readonly discoveryEnabled: boolean
}

type State = { readonly _tag: "inactive" } | ({ readonly _tag: "active" } & Active)

export interface Interface {
  readonly start: (input?: StartInput) => Effect.Effect<Status, UnavailableError>
  readonly stop: () => Effect.Effect<void, UnavailableError>
  readonly setEnabled: (enabled: boolean, input?: StartInput) => Effect.Effect<Status, UnavailableError>
  /**
   * Atomically rotate this host identity and restart the listener under the new
   * key. The persisted continuity proof authorizes no peer authority by itself;
   * every remote trust transition still requires a fresh SAS confirmation.
   */
  readonly rotateIdentity: (expectedPeerID: Ofxp.PeerID) => Effect.Effect<Status, UnavailableError | ConflictError>
  /**
   * Explicitly close the current rotation continuity window. This preserves the
   * replacement identity key and only removes its old-key continuity journal.
   */
  readonly finalizeIdentityRotation: (
    expectedPeerID: Ofxp.PeerID,
  ) => Effect.Effect<Status, UnavailableError | ConflictError>
  readonly status: () => Effect.Effect<Status>
  /** Secret-free Tier-0 projection suitable for an already-configured server to use as a discovery hint. */
  readonly bootstrap: () => Effect.Effect<BootstrapProjection>
  /** Replace renderer-provided ServerConnection hints. These are discovery-only and grant zero trust. */
  readonly replaceServerSeeds: (seeds: readonly OfxpDiscovery.CandidateSeed[]) => Effect.Effect<number>
  readonly candidates: () => Effect.Effect<readonly OfxpDiscovery.Candidate[]>
  /**
   * Side-effect-free snapshot of already-authenticated outbound connections.
   * Reading this must never dial or create a reconnect/health loop.
   */
  readonly connectionStatuses: () => Effect.Effect<readonly OfxpConnectionManager.ConnectionStatus[]>
  readonly pairingPreviews: () => Effect.Effect<readonly OfxpPairing.Preview[]>
  readonly initiatePairing: (peerID: Ofxp.PeerID) => Effect.Effect<OfxpPairing.Preview, Error>
  readonly confirmPairing: (
    pairingID: Ofxp.PairingID,
  ) => Effect.Effect<
    OfxpPeer.Record,
    | PairingError
    | ConflictError
    | OfxpPeer.OfxpPeerSchema.NotFoundError
    | OfxpPeer.OfxpPeerSchema.ValidationError
    | OfxpPeer.OfxpPeerSchema.IdentityMismatchError
  >
  readonly cancelPairing: (pairingID: Ofxp.PairingID) => Effect.Effect<boolean>
  readonly trustedPeers: () => Effect.Effect<ReadonlyArray<OfxpPeer.Record>>
  readonly remoteRoots: (
    peerID: Ofxp.PeerID,
    signal?: AbortSignal,
  ) => Effect.Effect<Ofxp.RootListResponse, Error | OfxpPeer.OfxpPeerSchema.NotFoundError>
  readonly remoteCapabilities: (
    peerID: Ofxp.PeerID,
    rootID?: Ofxp.RootID,
    signal?: AbortSignal,
  ) => Effect.Effect<Ofxp.CapabilityListResponse, Error | OfxpPeer.OfxpPeerSchema.NotFoundError>
  readonly describeRemoteCapability: (
    peerID: Ofxp.PeerID,
    capability: Ofxp.CapabilityID,
    signal?: AbortSignal,
  ) => Effect.Effect<Ofxp.CapabilityDescribeResponse, Error | OfxpPeer.OfxpPeerSchema.NotFoundError>
  readonly remoteReceipt: (
    peerID: Ofxp.PeerID,
    invocationID: Ofxp.InvocationID,
    signal?: AbortSignal,
  ) => Effect.Effect<Ofxp.ReceiptGetResponse, Error | OfxpPeer.OfxpPeerSchema.NotFoundError>
  readonly invokeRemoteCapability: (
    input: CapabilityInvocation,
    signal?: AbortSignal,
  ) => Effect.Effect<Ofxp.CapabilityResponse, Error | OfxpPeer.OfxpPeerSchema.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OfxpRuntime") {}
export const use = serviceUse(Service)

function cleanLabel(value: string) {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
  return cleaned || "OpenFork"
}

function configuredPublicOrigin() {
  const value = process.env.OPENCODE_PUBLIC_URL?.trim()
  if (!value) return
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    url.username = ""
    url.password = ""
    url.hash = ""
    url.search = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return
  }
}

function statusOf(state: State): Status {
  if (state._tag === "inactive") return { active: false, discovery: "disabled" }
  const continuityProof = state.continuityProof
  const now = Date.now()
  return {
    active: true,
    peerID: state.identity.id,
    label: state.identity.label,
    port: state.endpoint.port,
    discovery: state.discovery,
    identityRotationSupported: OfxpIdentityStore.supportsRotation(state.identityStore),
    ...(state.discoveryError ? { discoveryError: state.discoveryError } : {}),
    ...(continuityProof
      ? {
          rotation: {
            previousPeerID: continuityProof.previousPeerID,
            expiresAt: continuityProof.expiresAt,
            expired: continuityProof.expiresAt <= now,
          },
        }
      : {}),
  }
}

function validContinuityProof(state: Active, now = Date.now()) {
  const proof = state.continuityProof
  if (
    !proof ||
    proof.expiresAt <= now ||
    proof.next.id !== state.identity.id ||
    proof.next.realmID !== state.identity.realmID ||
    proof.next.label !== state.identity.label ||
    proof.next.publicKeySpki !== state.identity.publicKeySpki ||
    proof.next.fingerprint !== state.identity.fingerprint
  ) {
    return
  }
  return proof
}

function sameDurableIdentity(current: Active, stored: OfxpIdentityStore.StoredIdentity) {
  const sameKey =
    current.key.peerID === stored.key.peerID &&
    current.key.fingerprint === stored.key.fingerprint &&
    current.key.publicKeySpki === stored.key.publicKeySpki &&
    current.key.privateKeyPkcs8 === stored.key.privateKeyPkcs8
  if (!sameKey) return false
  return JSON.stringify(current.continuityProof ?? null) === JSON.stringify(stored.continuityProof ?? null)
}

function rotationConflictDetail(conflict: RotationPolicyConflict) {
  switch (conflict.kind) {
    case "identity_changed":
      return `OFXP identity changed concurrently (expected ${conflict.expectedPeerID}, current ${conflict.currentPeerID})`
    case "continuity_active":
      return `OFXP continuity proof remains valid until ${new Date(conflict.expiresAt).toISOString()}; it cannot be finalized or superseded early`
    case "continuity_expired_unfinalized":
      return "OFXP identity rotation continuity expired; finalize the current rotation before rotating again"
  }
}

function targetHosts(candidate: OfxpDiscovery.Candidate) {
  const values: Array<{ host: string; port: number }> = []
  const seen = new Set<string>()
  for (const instance of candidate.instances) {
    const hosts = instance.endpoint.addresses.length ? instance.endpoint.addresses : [instance.endpoint.host]
    for (const host of hosts) {
      const key = `${host}:${instance.endpoint.port}`
      if (seen.has(key)) continue
      seen.add(key)
      values.push({ host, port: instance.endpoint.port })
      if (values.length >= OfxpDiscovery.MAX_INSTANCES_PER_PEER) return values
    }
  }
  return values
}

function sanitizeServerSeeds(seeds: readonly OfxpDiscovery.CandidateSeed[]) {
  const values = new Map<string, OfxpDiscovery.CandidateSeed>()
  for (const seed of seeds.slice(0, OfxpDiscovery.MAX_CANDIDATES)) {
    const projection = OfxpDiscovery.projectSeed({ ...seed, source: "server" })
    if (!projection) continue
    values.set(projection.id, {
      source: "server",
      id: projection.id,
      peerID: projection.peerID,
      realmID: projection.realmID,
      openforkVersion: projection.openforkVersion,
      protocolVersion: projection.protocolVersion,
      pairing: projection.pairing,
      endpoint: {
        host: projection.endpoint.host,
        port: projection.endpoint.port,
        addresses: projection.endpoint.addresses,
      },
    })
  }
  return [...values.values()]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const config = yield* Config.Service
    const peers = yield* OfxpPeer.Service
    const capabilities = yield* OfxpCapability.Service
    const bridge = yield* EffectBridge.make()
    const state = yield* SynchronizedRef.make<State>({ _tag: "inactive" })
    let serverSeeds: readonly OfxpDiscovery.CandidateSeed[] = []
    let onIdentityStoreChange: (() => void) | undefined
    let stopIdentityWatch: (() => void) | undefined

    const unsubscribePeerChanges = peers.subscribe((change) => {
      if (
        change.kind !== "revoked" &&
        change.kind !== "rekey-required" &&
        change.kind !== "authority-changed"
      ) {
        return
      }
      void Effect.runPromise(
        Effect.gen(function* () {
          const current = yield* SynchronizedRef.get(state)
          if (current._tag !== "active") return

          if (change.kind === "authority-changed") {
            const record = yield* peers.get(change.peerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!record || record.info.revokedAt !== undefined || record.info.rekeyState !== "stable") {
              current.pairing.cancelPeer(change.peerID)
            }
          } else {
            current.pairing.cancelPeer(change.peerID)
          }

          // Any authority-generation change invalidates pooled authenticated
          // transport state. Pairing remains identity-only unless trust itself
          // was revoked/re-keyed.
          yield* Effect.promise(() => current.connections.closePeer(change.peerID))
        }).pipe(Effect.catch(() => Effect.void)),
      )
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribePeerChanges))

    const openActive = Effect.fn("OfxpRuntime.openActive")(function* (input: StartInput = {}) {
      return yield* Effect.tryPromise({
        try: async () => {
          const store =
            input.identityStore ?? new OfxpIdentityStore.FileStore(path.join(global.state, "ofxp", "identity.json"))
          const stored = await OfxpIdentityStore.loadOrCreateStored(store)
          const key = stored.key
          const label = cleanLabel(input.label ?? os.hostname())
          const identity: Ofxp.PeerIdentity = {
            id: key.peerID,
            realmID: serviceRealmID(global.state),
            label,
            publicKeySpki: key.publicKeySpki,
            fingerprint: key.fingerprint,
          }
          const continuityProof =
            stored.continuityProof &&
            stored.continuityProof.next.id === identity.id &&
            stored.continuityProof.next.realmID === identity.realmID &&
            stored.continuityProof.next.label === identity.label &&
            stored.continuityProof.next.publicKeySpki === identity.publicKeySpki &&
            stored.continuityProof.next.fingerprint === identity.fingerprint
              ? stored.continuityProof
              : undefined
          const material = await OfxpCertificate.issue(key)
          const connections = new OfxpConnectionManager.Manager(
            material,
            OfxpConnectionManager.DEFAULT_MAX_CONNECTIONS,
            undefined,
            OfxpClient.negotiate,
          )
          const pairing = new OfxpPairing.Coordinator(identity)
          const hello: Ofxp.Hello = {
            protocolMin: 1,
            protocolMax: 1,
            peerID: identity.id,
            realmID: identity.realmID,
            openforkVersion: InstallationVersion,
            surfaceFingerprint: SURFACE_FINGERPRINT,
            features: {
              pairing: true,
              capabilityExchange: true,
              messaging: false,
              supervision: false,
              delegation: false,
            },
          }
          const listenHost = input.host ?? "0.0.0.0"
          const discoveryEnabled = input.discovery !== false
          const endpoint = await OfxpTransport.start({
            material,
            identity,
            hello,
            pairing,
            ...(continuityProof ? { localRekeyProof: continuityProof } : {}),
            host: listenHost,
            port: input.port ?? 0,
            application: ({ peer, method, body, signal }) =>
              bridge.promise(capabilities.dispatch(peer, method, body, signal)),
          })

          const directory = new OfxpDiscovery.Directory(identity.id)
          directory.replaceSeeds("server", serverSeeds)
          let mdns: OfxpDiscovery.Mdns | undefined
          let discovery: DiscoveryState = discoveryEnabled ? "active" : "disabled"
          let discoveryError: string | undefined
          if (discoveryEnabled) {
            mdns = new OfxpDiscovery.Mdns(
              {
                peerID: identity.id,
                realmID: identity.realmID,
                openforkVersion: InstallationVersion,
                port: endpoint.port,
                pairing: true,
              },
              directory,
            )
            try {
              mdns.start()
            } catch (error) {
              discovery = "degraded"
              discoveryError = error instanceof Error ? error.message : String(error)
            }
          }

          const client = new OfxpClient.Client(identity, peers, connections, (peerID) => {
            const candidate = directory.list().find((item) => item.peerID === peerID)
            return candidate ? targetHosts(candidate) : []
          })

          return {
            _tag: "active",
            key,
            identity,
            identityStore: store,
            ...(continuityProof ? { continuityProof } : {}),
            material,
            pairing,
            connections,
            client,
            endpoint,
            directory,
            mdns,
            discovery,
            ...(discoveryError ? { discoveryError } : {}),
            listenHost,
            discoveryEnabled,
          } satisfies State
        },
        catch: (cause) =>
          new UnavailableError({
            detail: `Unable to start OFXP: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
    })

    const closeActiveStrict = Effect.fn("OfxpRuntime.closeActiveStrict")(function* (current: Active) {
      yield* Effect.tryPromise({
        try: async () => {
          try {
            current.mdns?.stop()
          } catch {
            // Discovery is advisory. Listener teardown remains authoritative.
          }
          const failures: unknown[] = []
          await current.connections.stop().catch((error) => failures.push(error))
          await current.endpoint.stop().catch((error) => failures.push(error))
          if (failures.length > 0) {
            throw new AggregateError(failures, "OFXP runtime teardown did not fully converge")
          }
        },
        catch: (cause) =>
          new UnavailableError({
            detail: `Unable to stop the current OFXP listener: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
    })

    const disarmIdentityWatch = () => {
      stopIdentityWatch?.()
      stopIdentityWatch = undefined
    }

    const armIdentityWatch = (current: State) => {
      if (stopIdentityWatch || current._tag !== "active" || !OfxpIdentityStore.supportsWatch(current.identityStore)) return
      stopIdentityWatch = current.identityStore.watch(() => onIdentityStoreChange?.())
    }

    const rearmIdentityWatch = Effect.fnUntraced(function* () {
      const current = yield* SynchronizedRef.get(state)
      yield* Effect.sync(() => armIdentityWatch(current))
    })

    let identityRetryScheduled = false
    const scheduleIdentityRetry = () => {
      if (identityRetryScheduled) return
      identityRetryScheduled = true
      const timer = setTimeout(() => {
        identityRetryScheduled = false
        onIdentityStoreChange?.()
      }, 1_000)
      timer.unref?.()
    }

    const reconcileDurableIdentity = Effect.fn("OfxpRuntime.reconcileDurableIdentity")(function* () {
      yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          if (current._tag !== "active" || !OfxpIdentityStore.supportsWatch(current.identityStore)) {
            return [undefined, current] as const
          }

          const loaded = yield* Effect.exit(
            Effect.tryPromise({
              try: async () => {
                const raw = await current.identityStore.read()
                if (raw === undefined) throw new Error("durable OFXP identity disappeared")
                return OfxpIdentityStore.parseStored(raw)
              },
              catch: (cause) =>
                new UnavailableError({
                  detail: `Unable to re-read durable OFXP identity: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            }),
          )

          if (Exit.isSuccess(loaded) && sameDurableIdentity(current, loaded.value)) {
            return [undefined, current] as const
          }

          const closed = yield* Effect.exit(closeActiveStrict(current))
          if (Exit.isFailure(closed)) {
            yield* Effect.logError("failed to retire superseded OFXP identity; retrying", { cause: closed.cause })
            yield* Effect.sync(scheduleIdentityRetry)
            return [undefined, current] as const
          }

          if (Exit.isFailure(loaded)) {
            yield* Effect.logError("durable OFXP identity became invalid; listener stopped fail-closed", {
              cause: loaded.cause,
            })
            return [undefined, { _tag: "inactive" } satisfies State] as const
          }

          const reopened = yield* Effect.exit(
            openActive({
              host: current.listenHost,
              port: current.endpoint.port,
              label: current.identity.label,
              discovery: current.discoveryEnabled,
              identityStore: current.identityStore,
            }),
          )
          if (Exit.isFailure(reopened)) {
            yield* Effect.logError("failed to reopen OFXP under externally rotated durable identity; remaining inactive", {
              cause: reopened.cause,
            })
            return [undefined, { _tag: "inactive" } satisfies State] as const
          }

          yield* Effect.logInfo("converged OFXP runtime to externally rotated durable identity", {
            previousPeerID: current.identity.id,
            peerID: reopened.value.identity.id,
          })
          return [undefined, reopened.value] as const
        }),
      )
    })

    onIdentityStoreChange = () => {
      void Effect.runPromise(
        reconcileDurableIdentity().pipe(
          Effect.tap(() =>
            SynchronizedRef.get(state).pipe(
              Effect.tap((current) => Effect.sync(() => current._tag === "inactive" && disarmIdentityWatch())),
            ),
          ),
          Effect.catchCause((cause) => Effect.logError("OFXP durable identity reconciliation failed", { cause })),
        ),
      )
    }

    const start = Effect.fn("OfxpRuntime.start")(function* (input: StartInput = {}) {
      yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          if (current._tag === "active") return [undefined, current] as const
          const started = yield* openActive(input)
          return [undefined, started] as const
        }),
      )
      // Arm once for the entire active lifetime. watchFile is path-based
      // and continues across same-directory atomic replacement, so re-registering
      // it per event would manufacture a Windows stat-notification feedback loop.
      // Re-read after arming to close the load->watch publication race.
      yield* rearmIdentityWatch()
      yield* reconcileDurableIdentity()
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") {
        return yield* new UnavailableError({ detail: "OFXP durable identity changed or became invalid during startup" })
      }
      return statusOf(current)
    })

    const stop = Effect.fn("OfxpRuntime.stop")(function* () {
      yield* Effect.sync(disarmIdentityWatch)
      const stopped = yield* Effect.exit(
        SynchronizedRef.modifyEffect(
          state,
          Effect.fnUntraced(function* (current) {
            if (current._tag === "inactive") return [undefined, current] as const
            yield* closeActiveStrict(current)
            return [undefined, { _tag: "inactive" } satisfies State] as const
          }),
        ),
      )
      if (Exit.isFailure(stopped)) {
        yield* rearmIdentityWatch()
        return yield* Effect.failCause(stopped.cause)
      }
    })

    /**
     * Tier-0 operator lifecycle owner.
     *
     * Enabling proves the listener transition before persisting intent so a
     * failed start can never leave enabled=true on disk. Disabling persists
     * intent before teardown because stop is convergent. If enable persistence
     * fails after this call newly started the runtime, compensate by stopping it
     * and rethrow the original config failure/defect.
     * No workspace Instance/config/tool graph participates in this path.
     */
    const setEnabled = Effect.fn("OfxpRuntime.setEnabled")(function* (enabled: boolean, input?: StartInput) {
      if (!enabled) {
        const previous = yield* config.getGlobal()
        yield* config.updateGlobal({ ofxp: { enabled: false } })
        const stopped = yield* Effect.exit(stop())
        if (Exit.isFailure(stopped)) {
          yield* config
            .updateGlobal({ ofxp: { enabled: previous.ofxp?.enabled === true } })
            .pipe(Effect.catchCause((cause) => Effect.logError("failed to roll back OFXP enabled preference", { cause })))
          return yield* Effect.failCause(stopped.cause)
        }
        return statusOf({ _tag: "inactive" })
      }

      const wasActive = (yield* SynchronizedRef.get(state))._tag === "active"
      const next = yield* start(input)
      const persisted = yield* Effect.exit(config.updateGlobal({ ofxp: { enabled: true } }))
      if (Exit.isSuccess(persisted)) return next
      if (!wasActive) yield* stop()
      return yield* Effect.failCause(persisted.cause)
    })

    const rotateIdentity = Effect.fn("OfxpRuntime.rotateIdentity")(function* (expectedPeerID: Ofxp.PeerID) {
      type RotationError = UnavailableError | ConflictError
      const failure = (effect: Effect.Effect<never, RotationError>): Effect.Effect<Status, RotationError> => effect
      const success = (value: Status): Effect.Effect<Status, RotationError> => Effect.succeed(value)
      return yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          if (current._tag !== "active") {
            return [failure(Effect.fail(new UnavailableError({ detail: "OFXP is not running" }))), current] as const
          }
          const policy = canRotateIdentity({
            currentPeerID: current.identity.id,
            expectedPeerID,
            continuityProof: current.continuityProof,
          })
          if (!policy.ok) {
            return [
              failure(Effect.fail(new ConflictError({ detail: rotationConflictDetail(policy.conflict) }))),
              current,
            ] as const
          }

          const identityStore = current.identityStore
          if (!OfxpIdentityStore.supportsRotation(identityStore)) {
            return [
              failure(
                Effect.fail(new UnavailableError({ detail: "OFXP identity storage does not support atomic rotation" })),
              ),
              current,
            ] as const
          }
          const nextKey = OfxpIdentity.generateKeyPair()
          const nextIdentity: Ofxp.PeerIdentity = {
            id: nextKey.peerID,
            realmID: current.identity.realmID,
            label: current.identity.label,
            publicKeySpki: nextKey.publicKeySpki,
            fingerprint: nextKey.fingerprint,
          }
          const proof = OfxpRekey.create({
            current: current.key,
            currentRealmID: current.identity.realmID,
            next: nextIdentity,
          })
          // Stop accepting the old TLS identity before the durable publication
          // point. At no instant may disk advertise the replacement key while
          // this process is still listening as the previous identity.
          yield* closeActiveStrict(current)
          const reopen = () =>
            openActive({
              host: current.listenHost,
              port: current.endpoint.port,
              label: current.identity.label,
              discovery: current.discoveryEnabled,
              identityStore,
            }).pipe(
              // Preserve the port when possible, but do not leave an enabled
              // runtime down merely because the prior port cannot be rebound.
              Effect.catch(() =>
                openActive({
                  host: current.listenHost,
                  port: 0,
                  label: current.identity.label,
                  discovery: current.discoveryEnabled,
                  identityStore,
                }),
              ),
            )

          const replaced = yield* Effect.exit(
            Effect.tryPromise({
              try: () => OfxpIdentityStore.rotateIfCurrent(identityStore, current.key, nextKey, proof),
              catch: (cause) =>
                new UnavailableError({
                  detail: `Unable to persist OFXP identity rotation: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            }),
          )
          if (Exit.isFailure(replaced)) {
            const recovered = yield* Effect.exit(reopen())
            return Exit.isSuccess(recovered)
              ? ([failure(Effect.failCause(replaced.cause)), recovered.value] as const)
              : ([failure(Effect.failCause(replaced.cause)), { _tag: "inactive" } satisfies State] as const)
          }

          // Another process won the CAS. Converge on its durable identity and
          // continuity proof rather than stranding an enabled process offline.
          if (!replaced.value) {
            const recovered = yield* Effect.exit(reopen())
            if (Exit.isFailure(recovered)) {
              return [failure(Effect.failCause(recovered.cause)), { _tag: "inactive" } satisfies State] as const
            }
            return [success(statusOf(recovered.value)), recovered.value] as const
          }

          const reopened = yield* Effect.exit(reopen())
          if (Exit.isFailure(reopened)) {
            return [failure(Effect.failCause(reopened.cause)), { _tag: "inactive" } satisfies State] as const
          }
          return [success(statusOf(reopened.value)), reopened.value] as const
        }),
      ).pipe(Effect.flatten)
    })

    const finalizeIdentityRotation = Effect.fn("OfxpRuntime.finalizeIdentityRotation")(function* (
      expectedPeerID: Ofxp.PeerID,
    ) {
      type RotationError = UnavailableError | ConflictError
      const failure = (effect: Effect.Effect<never, RotationError>): Effect.Effect<Status, RotationError> => effect
      const success = (value: Status): Effect.Effect<Status, RotationError> => Effect.succeed(value)
      return yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          if (current._tag !== "active") {
            return [failure(Effect.fail(new UnavailableError({ detail: "OFXP is not running" }))), current] as const
          }
          const policy = canFinalizeIdentityRotation({
            currentPeerID: current.identity.id,
            expectedPeerID,
            continuityProof: current.continuityProof,
          })
          if (!policy.ok) {
            return [
              failure(Effect.fail(new ConflictError({ detail: rotationConflictDetail(policy.conflict) }))),
              current,
            ] as const
          }
          if (!current.continuityProof) return [success(statusOf(current)), current] as const

          const identityStore = current.identityStore
          if (!OfxpIdentityStore.supportsRotation(identityStore)) {
            return [
              failure(
                Effect.fail(new UnavailableError({ detail: "OFXP identity storage does not support atomic rotation" })),
              ),
              current,
            ] as const
          }

          yield* closeActiveStrict(current)
          const reopen = () =>
            openActive({
              host: current.listenHost,
              port: current.endpoint.port,
              label: current.identity.label,
              discovery: current.discoveryEnabled,
              identityStore,
            }).pipe(
              Effect.catch(() =>
                openActive({
                  host: current.listenHost,
                  port: 0,
                  label: current.identity.label,
                  discovery: current.discoveryEnabled,
                  identityStore,
                }),
              ),
            )

          const cleared = yield* Effect.exit(
            Effect.tryPromise({
              try: () => OfxpIdentityStore.clearContinuityProofIfCurrent(identityStore, current.key),
              catch: (cause) =>
                new UnavailableError({
                  detail: `Unable to finalize OFXP identity rotation: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            }),
          )
          if (Exit.isFailure(cleared)) {
            const recovered = yield* Effect.exit(reopen())
            return Exit.isSuccess(recovered)
              ? ([failure(Effect.failCause(cleared.cause)), recovered.value] as const)
              : ([failure(Effect.failCause(cleared.cause)), { _tag: "inactive" } satisfies State] as const)
          }

          const reopened = yield* Effect.exit(reopen())
          if (Exit.isFailure(reopened)) {
            return [failure(Effect.failCause(reopened.cause)), { _tag: "inactive" } satisfies State] as const
          }
          if (!cleared.value && reopened.value.continuityProof) {
            return [
              failure(
                Effect.fail(
                  new ConflictError({
                    detail: "OFXP identity changed concurrently; review the current rotation state before finalizing",
                  }),
                ),
              ),
              reopened.value,
            ] as const
          }
          return [success(statusOf(reopened.value)), reopened.value] as const
        }),
      ).pipe(Effect.flatten)
    })

    const status = Effect.fn("OfxpRuntime.status")(function* () {
      return statusOf(yield* SynchronizedRef.get(state))
    })

    const bootstrap = Effect.fn("OfxpRuntime.bootstrap")(function* () {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return { enabled: false } satisfies BootstrapProjection
      const publicOrigin = configuredPublicOrigin()
      return {
        enabled: true,
        peerID: current.identity.id,
        fingerprint: current.identity.fingerprint,
        protocolMin: OfxpDiscovery.PROTOCOL_VERSION,
        protocolMax: OfxpDiscovery.PROTOCOL_VERSION,
        pairing: true,
        endpointHints: [{ port: current.endpoint.port }],
        ...(publicOrigin ? { publicOrigin } : {}),
      } satisfies BootstrapProjection
    })

    const replaceServerSeeds = Effect.fn("OfxpRuntime.replaceServerSeeds")(function* (
      seeds: readonly OfxpDiscovery.CandidateSeed[],
    ) {
      const sanitized = sanitizeServerSeeds(seeds)
      return yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          serverSeeds = sanitized
          const accepted =
            current._tag === "active" ? current.directory.replaceSeeds("server", sanitized) : sanitized.length
          return [accepted, current] as const
        }),
      )
    })

    const candidates = Effect.fn("OfxpRuntime.candidates")(function* () {
      const current = yield* SynchronizedRef.get(state)
      return current._tag === "active" ? current.directory.list() : []
    })

    const connectionStatuses = Effect.fn("OfxpRuntime.connectionStatuses")(function* () {
      const current = yield* SynchronizedRef.get(state)
      return current._tag === "active" ? current.connections.snapshot() : []
    })

    const pairingPreviews = Effect.fn("OfxpRuntime.pairingPreviews")(function* () {
      const current = yield* SynchronizedRef.get(state)
      return current._tag === "active" ? current.pairing.previews() : []
    })

    const initiatePairing = Effect.fn("OfxpRuntime.initiatePairing")(function* (peerID: Ofxp.PeerID) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") {
        return yield* new UnavailableError({ detail: "OFXP is not running" })
      }
      const candidate = current.directory.list().find((item) => item.peerID === peerID)
      if (!candidate) {
        return yield* new OfxpClient.PeerUnavailableError({ peerID, detail: `OFXP peer is not currently discoverable: ${peerID}` })
      }
      const targets = targetHosts(candidate)
      if (targets.length === 0) {
        return yield* new OfxpClient.PeerUnavailableError({ peerID, detail: `OFXP peer has no usable endpoint: ${peerID}` })
      }

      const offer = current.pairing.begin(Date.now(), validContinuityProof(current))
      let lastError: unknown
      for (const target of targets) {
        const result = yield* Effect.tryPromise({
          try: () =>
            OfxpTransport.offerPairing({
              material: current.material,
              endpoint: target,
              expectedPeerID: peerID,
              offer,
            }),
          catch: (cause) => new PairingError({ detail: cause instanceof Error ? cause.message : String(cause) }),
        }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )
        if (!result.ok) {
          lastError = result.error
          continue
        }
        return yield* Effect.try({
          try: () => current.pairing.acceptAnswer(result.value.answer),
          catch: (cause) => new PairingError({ detail: cause instanceof Error ? cause.message : String(cause) }),
        })
      }
      current.pairing.cancel(offer.pairingID)
      return yield* new OfxpClient.PeerUnavailableError({
        peerID,
        detail: `Unable to reach OFXP peer ${peerID}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      })
    })

    const confirmPairing = Effect.fn("OfxpRuntime.confirmPairing")(function* (pairingID: Ofxp.PairingID) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new PairingError({ detail: "OFXP is not running" })
      const confirmation = yield* Effect.try({
        try: () => current.pairing.confirmWithMetadata(pairingID),
        catch: (cause) => new PairingError({ detail: cause instanceof Error ? cause.message : String(cause) }),
      })
      const generationPeerID = confirmation.rekeyProof?.previousPeerID ?? confirmation.peer.id
      const generation = yield* peers.get(generationPeerID).pipe(
        Effect.map((record) => ({ known: true as const, record })),
        Effect.catchTag("OfxpPeer.NotFoundError", () => Effect.succeed({ known: false as const })),
      )
      if (
        generation.known &&
        (generation.record.info.pairedAt > confirmation.startedAt ||
          (generation.record.info.revokedAt !== undefined &&
            generation.record.info.revokedAt >= confirmation.startedAt))
      ) {
        return yield* new ConflictError({
          detail: `OFXP peer trust changed after pairing began: ${generationPeerID}`,
        })
      }
      if (!confirmation.rekeyProof) return yield* peers.trust({ identity: confirmation.peer })
      if (!generation.known) return yield* peers.trust({ identity: confirmation.peer })
      return yield* peers.rekeyTrust({ proof: confirmation.rekeyProof })
    })

    const cancelPairing = Effect.fn("OfxpRuntime.cancelPairing")(function* (pairingID: Ofxp.PairingID) {
      const current = yield* SynchronizedRef.get(state)
      return current._tag === "active" ? current.pairing.cancel(pairingID) : false
    })

    const trustedPeers = Effect.fn("OfxpRuntime.trustedPeers")(function* () {
      return yield* peers.list()
    })

    const remoteRoots = Effect.fn("OfxpRuntime.remoteRoots")(function* (peerID: Ofxp.PeerID, signal?: AbortSignal) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new UnavailableError({ detail: "OFXP is not running" })
      return yield* current.client.roots(peerID, signal)
    })

    const remoteCapabilities = Effect.fn("OfxpRuntime.remoteCapabilities")(function* (
      peerID: Ofxp.PeerID,
      rootID?: Ofxp.RootID,
      signal?: AbortSignal,
    ) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new UnavailableError({ detail: "OFXP is not running" })
      return yield* current.client.capabilities(peerID, rootID, signal)
    })

    const describeRemoteCapability = Effect.fn("OfxpRuntime.describeRemoteCapability")(function* (
      peerID: Ofxp.PeerID,
      capability: Ofxp.CapabilityID,
      signal?: AbortSignal,
    ) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new UnavailableError({ detail: "OFXP is not running" })
      return yield* current.client.describe(peerID, capability, signal)
    })

    const remoteReceipt = Effect.fn("OfxpRuntime.remoteReceipt")(function* (
      peerID: Ofxp.PeerID,
      invocationID: Ofxp.InvocationID,
      signal?: AbortSignal,
    ) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new UnavailableError({ detail: "OFXP is not running" })
      return yield* current.client.receipt(peerID, invocationID, signal)
    })

    const invokeRemoteCapability = Effect.fn("OfxpRuntime.invokeRemoteCapability")(function* (
      input: CapabilityInvocation,
      signal?: AbortSignal,
    ) {
      const current = yield* SynchronizedRef.get(state)
      if (current._tag !== "active") return yield* new UnavailableError({ detail: "OFXP is not running" })
      return yield* current.client.invoke(input, signal)
    })

    const service = Service.of({
      start,
      stop,
      setEnabled,
      rotateIdentity,
      finalizeIdentityRotation,
      status,
      bootstrap,
      replaceServerSeeds,
      candidates,
      connectionStatuses,
      pairingPreviews,
      initiatePairing,
      confirmPairing,
      cancelPairing,
      trustedPeers,
      remoteRoots,
      remoteCapabilities,
      describeRemoteCapability,
      remoteReceipt,
      invokeRemoteCapability,
    })

    const globalConfig = yield* config.getGlobal()
    if (globalConfig.ofxp?.enabled === true) {
      yield* start().pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to restore enabled OFXP runtime", {
            error: error.message,
          }),
        ),
      )
    }

    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, Config.node, OfxpPeer.node, OfxpCapability.node],
})
