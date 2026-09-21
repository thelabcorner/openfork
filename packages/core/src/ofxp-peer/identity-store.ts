export * as OfxpIdentityStore from "./identity-store"

import { randomUUID } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpIdentity, type KeyPair } from "./identity"
import { Flock } from "../util/flock"

const LEGACY_FORMAT_VERSION = 1
const FORMAT_VERSION = 2
const MAX_BYTES = 32 * 1024

type PayloadV1 = {
  readonly version: typeof LEGACY_FORMAT_VERSION
  readonly privateKeyPkcs8: string
}

type PayloadV2 = {
  readonly version: typeof FORMAT_VERSION
  readonly privateKeyPkcs8: string
  readonly continuityProof?: Ofxp.RekeyProof
}

export interface StoredIdentity {
  readonly key: KeyPair
  readonly continuityProof?: Ofxp.RekeyProof
}

export interface Store {
  /** Returns serialized identity material or undefined when no identity exists. */
  readonly read: () => Promise<string | undefined>
  /** Atomically creates identity material. False means another writer won the race. */
  readonly writeIfAbsent: (value: string) => Promise<boolean>
}

/**
 * Optional durable capability for identity rotation.
 *
 * Replacing identity material is security-sensitive and must be a real
 * compare-and-swap. Stores that cannot provide cross-process atomic replacement
 * should implement Store only and remain non-rotatable.
 */
export interface RotatableStore extends Store {
  readonly replaceIfCurrent: (expected: string, value: string) => Promise<boolean>
}

export interface WatchableStore extends Store {
  /**
   * Observe durable identity-file generation changes without exposing key data.
   * Consumers must re-read and validate the store before acting.
   */
  readonly watch: (listener: () => void, options?: { readonly intervalMs?: number }) => () => void
}

function code(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function normalizedKeyPair(key: KeyPair): KeyPair {
  const validated = OfxpIdentity.validateKeyPair(key)
  if (validated.peerID !== key.peerID || validated.fingerprint !== key.fingerprint) {
    throw new Error("OFXP identity key metadata does not match its keypair")
  }
  return Object.freeze({ ...validated, privateKeyPkcs8: key.privateKeyPkcs8 })
}

function serialize(key: KeyPair, continuityProof?: Ofxp.RekeyProof) {
  const normalized = normalizedKeyPair(key)
  let proof: Ofxp.RekeyProof | undefined
  if (continuityProof) {
    proof = Schema.decodeUnknownSync(Ofxp.RekeyProof)(continuityProof, { onExcessProperty: "error" })
    const next = OfxpIdentity.validatePeerIdentity(proof.next)
    if (
      next.id !== normalized.peerID ||
      next.fingerprint !== normalized.fingerprint ||
      next.publicKeySpki !== normalized.publicKeySpki
    ) {
      throw new Error("OFXP continuity proof does not describe the stored replacement identity")
    }
  }
  const payload: PayloadV2 = {
    version: FORMAT_VERSION,
    privateKeyPkcs8: normalized.privateKeyPkcs8,
    ...(proof ? { continuityProof: proof } : {}),
  }
  return `${JSON.stringify(payload)}\n`
}

export function parseStored(value: string): StoredIdentity {
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new Error("OFXP identity material is unexpectedly large")
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Stored OFXP identity material is invalid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored OFXP identity material is invalid")
  const row = parsed as Record<string, unknown>
  const version = row.version
  if (version !== LEGACY_FORMAT_VERSION && version !== FORMAT_VERSION) {
    throw new Error("Stored OFXP identity material is invalid")
  }
  const allowed = version === LEGACY_FORMAT_VERSION
    ? new Set(["version", "privateKeyPkcs8"])
    : new Set(["version", "privateKeyPkcs8", "continuityProof"])
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error("Stored OFXP identity material has unknown fields")
  }
  if (typeof row.privateKeyPkcs8 !== "string" || row.privateKeyPkcs8.length > MAX_BYTES) {
    throw new Error("Stored OFXP identity material is invalid")
  }
  const publicKeySpki = OfxpIdentity.publicKeyFromPrivateKey(row.privateKeyPkcs8)
  const validated = OfxpIdentity.validateKeyPair({ publicKeySpki, privateKeyPkcs8: row.privateKeyPkcs8 })
  const key = Object.freeze({ ...validated, privateKeyPkcs8: row.privateKeyPkcs8 })
  if (version === LEGACY_FORMAT_VERSION || row.continuityProof === undefined) return Object.freeze({ key })
  const continuityProof = Schema.decodeUnknownSync(Ofxp.RekeyProof)(row.continuityProof, { onExcessProperty: "error" })
  const next = OfxpIdentity.validatePeerIdentity(continuityProof.next)
  if (next.id !== key.peerID || next.fingerprint !== key.fingerprint || next.publicKeySpki !== key.publicKeySpki) {
    throw new Error("Stored OFXP continuity proof does not match the stored identity")
  }
  return Object.freeze({ key, continuityProof })
}

export function parse(value: string): KeyPair {
  return parseStored(value).key
}

/**
 * Race-safe load/create. The store owns atomic create semantics; a loser never
 * overwrites the winning identity and simply reloads it.
 */
export async function loadOrCreate(store: Store): Promise<KeyPair> {
  return (await loadOrCreateStored(store)).key
}

export async function loadOrCreateStored(store: Store): Promise<StoredIdentity> {
  const current = await store.read()
  if (current !== undefined) return parseStored(current)

  const generated = OfxpIdentity.generateKeyPair()
  if (await store.writeIfAbsent(serialize(generated))) return Object.freeze({ key: generated })

  const winner = await store.read()
  if (winner === undefined) throw new Error("OFXP identity creation lost a race but no winning identity exists")
  return parseStored(winner)
}

export function supportsRotation(store: Store): store is RotatableStore {
  return "replaceIfCurrent" in store && typeof store.replaceIfCurrent === "function"
}

export function supportsWatch(store: Store): store is WatchableStore {
  return "watch" in store && typeof store.watch === "function"
}

function sameKey(left: KeyPair, right: KeyPair) {
  return (
    left.peerID === right.peerID &&
    left.fingerprint === right.fingerprint &&
    left.publicKeySpki === right.publicKeySpki &&
    left.privateKeyPkcs8 === right.privateKeyPkcs8
  )
}

/**
 * Atomically replace one durable identity only when the caller still owns the
 * exact key that is on disk. A stale process receives false and must reload.
 */
export async function rotateIfCurrent(
  store: RotatableStore,
  expected: KeyPair,
  next: KeyPair,
  continuityProof?: Ofxp.RekeyProof,
): Promise<boolean> {
  const current = await store.read()
  if (current === undefined) return false
  if (!sameKey(parseStored(current).key, normalizedKeyPair(expected))) return false
  return store.replaceIfCurrent(current, serialize(next, continuityProof))
}

/**
 * Remove only the continuity journal for the current key. This is an exact
 * record CAS so a concurrent metadata/key change can never be overwritten.
 */
export async function clearContinuityProofIfCurrent(store: RotatableStore, expected: KeyPair): Promise<boolean> {
  const current = await store.read()
  if (current === undefined) return false
  const stored = parseStored(current)
  if (!sameKey(stored.key, normalizedKeyPair(expected))) return false
  if (!stored.continuityProof) return true
  return store.replaceIfCurrent(current, serialize(expected))
}

export type FileStoreOptions = {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
}

/**
 * Strict host-key style storage for headless runtimes. The material is not
 * encrypted: its security boundary is the local OS account, equivalent to an
 * SSH host private key. Desktop can provide a different Store backed by native
 * secure storage without changing OFXP identity semantics.
 */
export class FileStore implements RotatableStore {
  private readonly platform: NodeJS.Platform
  private readonly uid: number | undefined

  constructor(
    readonly file: string,
    options: FileStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform
    this.uid = options.uid ?? process.getuid?.()
  }

  async read() {
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(this.file)
    } catch (error) {
      if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error("Refusing symlinked OFXP identity file")
    if (!stat.isFile()) throw new Error("OFXP identity path is not a regular file")
    if (stat.size > MAX_BYTES) throw new Error("OFXP identity file is unexpectedly large")
    if (this.platform !== "win32") {
      if (this.uid !== undefined && stat.uid !== this.uid) throw new Error("OFXP identity file is owned by another OS user")
      if ((stat.mode & 0o077) !== 0) throw new Error("OFXP identity file permissions are too broad; expected mode 0600")
    }
    return fs.readFile(this.file, "utf8")
  }

  async writeIfAbsent(value: string) {
    if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new Error("OFXP identity material is unexpectedly large")
    const directory = path.dirname(this.file)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(temporary, "wx", 0o600)
      await handle.writeFile(value, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      if (this.platform !== "win32") await fs.chmod(temporary, 0o600)
      // link() is create-if-absent at the target name. Unlike rename(), it can
      // never replace a concurrently created identity.
      try {
        await fs.link(temporary, this.file)
      } catch (error) {
        if (code(error) === "EEXIST") return false
        throw error
      }
      return true
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async replaceIfCurrent(expected: string, value: string) {
    if (Buffer.byteLength(expected, "utf8") > MAX_BYTES || Buffer.byteLength(value, "utf8") > MAX_BYTES) {
      throw new Error("OFXP identity material is unexpectedly large")
    }
    parseStored(expected)
    parse(value)

    const directory = path.dirname(this.file)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const lockDirectory = path.join(directory, ".identity-locks")
    const lease = await Flock.acquire(`ofxp-identity:${path.resolve(this.file)}`, {
      dir: lockDirectory,
      staleMs: 30_000,
      timeoutMs: 30_000,
      baseDelayMs: 10,
      maxDelayMs: 250,
    })
    const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const current = await this.read()
      if (current === undefined) return false
      parseStored(current)
      if (current !== expected) return false

      handle = await fs.open(temporary, "wx", 0o600)
      await handle.writeFile(value, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      if (this.platform !== "win32") await fs.chmod(temporary, 0o600)

      // Same-directory rename is the atomic publication point. Readers observe
      // either the old complete identity or the new complete identity, never a
      // delete/replace gap.
      await fs.rename(temporary, this.file)
      if (this.platform !== "win32") {
        const directoryHandle = await fs.open(directory, "r")
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
      return true
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      await lease.release()
    }
  }

  watch(listener: () => void, options: { readonly intervalMs?: number } = {}) {
    const interval = Math.max(50, Math.floor(options.intervalMs ?? 500))
    const onChange = (
      current: import("node:fs").Stats,
      previous: import("node:fs").Stats,
    ) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ino === previous.ino &&
        current.nlink === previous.nlink
      ) {
        return
      }
      listener()
    }
    watchFile(this.file, { persistent: false, interval }, onChange)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      unwatchFile(this.file, onChange)
    }
  }
}

