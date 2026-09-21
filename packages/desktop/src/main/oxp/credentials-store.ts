
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE_NAME = "oxp-secrets.bin"
const LINUX_BASIC_TEXT_PREFIX = Buffer.from("v10", "ascii")
const LINUX_STORAGE_PROBE = "openfork-oxp-safe-storage-probe"
const REJECTED_CREDENTIAL_INDEX_KEY = "credentialIndexV1"
const REJECTED_CREDENTIAL_SECRET_PREFIX = "credentialSecret:"

export type SecureStorageStatus = { available: boolean; detail?: string }

export interface SecureStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

function stripRejectedCredentialRegistry(values: Record<string, string>) {
  const next = { ...values }
  let changed = false
  if (REJECTED_CREDENTIAL_INDEX_KEY in next) {
    delete next[REJECTED_CREDENTIAL_INDEX_KEY]
    changed = true
  }
  for (const key of Object.keys(next)) {
    if (!key.startsWith(REJECTED_CREDENTIAL_SECRET_PREFIX)) continue
    delete next[key]
    changed = true
  }
  return { values: next, changed }
}

export function secureStorageCiphertextIsProtected(
  encrypted: Buffer,
  platform: NodeJS.Platform = process.platform,
) {
  return platform !== "linux" || !encrypted.subarray(0, LINUX_BASIC_TEXT_PREFIX.length).equals(LINUX_BASIC_TEXT_PREFIX)
}

export async function secureStorageStatus(
  storage: SecureStorageAdapter,
  platform: NodeJS.Platform = process.platform,
): Promise<SecureStorageStatus> {
  try {
    if (!(await storage.isAsyncEncryptionAvailable())) {
      return {
        available: false,
        detail:
          platform === "linux"
            ? "Secure credential storage is unavailable. Start or unlock a desktop keyring/Secret Service, then try again."
            : "Secure operating-system credential storage is unavailable on this machine.",
      }
    }
    if (platform === "linux") {
      const probe = await storage.encryptStringAsync(LINUX_STORAGE_PROBE)
      if (!secureStorageCiphertextIsProtected(probe, platform)) {
        return {
          available: false,
          detail: "Linux secure storage fell back to Chromium's insecure hard-coded-key provider.",
        }
      }
    }
    return { available: true }
  } catch {
    return { available: false, detail: "Secure operating-system credential storage could not be initialized." }
  }
}

export class OxpCredentialStore {
  private readonly file: string
  private cache: Record<string, string> | null = null
  private loadInFlight: Promise<Record<string, string>> | null = null
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  private rotationPending = false
  private unreadable = false

  constructor(
    userDataPath: string,
    private readonly storage: SecureStorageAdapter,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly onUnreadable?: () => void,
  ) {
    this.file = path.join(userDataPath, FILE_NAME)
  }

  status() {
    return secureStorageStatus(this.storage, this.platform)
  }

  credentialState(): "ready" | "unreadable" {
    return this.unreadable ? "unreadable" : "ready"
  }

  private parse(json: string) {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored credential payload is invalid")
    for (const value of Object.values(parsed)) if (typeof value !== "string") throw new Error("Stored credential payload is invalid")
    return parsed as Record<string, string>
  }

  private async loadAll() {
    const generation = this.generation
    if (!(await this.status()).available) return {}
    try {
      const blob = await fs.readFile(this.file)
      if (!secureStorageCiphertextIsProtected(blob, this.platform)) {
        if (generation !== this.generation) return this.cache ?? {}
        this.unreadable = true
        this.rotationPending = false
        this.onUnreadable?.()
        return {}
      }
      const decrypted = await this.storage.decryptStringAsync(blob)
      const parsed = this.parse(decrypted.result)
      const cleaned = stripRejectedCredentialRegistry(parsed)
      if (generation !== this.generation) return this.cache ?? {}
      this.cache = cleaned.values
      this.unreadable = false
      this.rotationPending = decrypted.shouldReEncrypt || cleaned.changed
      return cleaned.values
    } catch (error) {
      if (generation !== this.generation) return this.cache ?? {}
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {}
        this.unreadable = false
        this.rotationPending = false
        return this.cache
      }
      // Deliberately keep cache === null. A read may project "no usable key",
      // but mutation must fail closed rather than replacing unreadable
      // ciphertext with an apparently authoritative empty object.
      this.unreadable = true
      this.onUnreadable?.()
      this.rotationPending = false
      return {}
    }
  }

  private async readAll() {
    if (this.cache) return this.cache
    if (this.loadInFlight) return this.loadInFlight
    const load = this.loadAll()
    this.loadInFlight = load
    try {
      return await load
    } finally {
      if (this.loadInFlight === load) this.loadInFlight = null
    }
  }

  private async writeAll(values: Record<string, string>) {
    if (!(await this.status()).available) throw new Error("Secure OS credential storage is unavailable.")
    const blob = await this.storage.encryptStringAsync(JSON.stringify(values))
    if (!secureStorageCiphertextIsProtected(blob, this.platform)) throw new Error("Secure OS credential storage is unavailable.")
    const temp = `${this.file}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(temp, blob, { mode: 0o600 })
    await fs.rename(temp, this.file)
    this.cache = values
    this.unreadable = false
    this.rotationPending = false
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async getOpenAiApiKey() {
    const values = await this.readAll()
    // Legacy Gate-L builds persisted a second Files-only credential. OXP now
    // has one OpenAI credential domain: prefer the canonical key when both are
    // present, but accept the legacy value so existing installations do not
    // lose file/tunnel access during the migration.
    const value = values.openaiApiKey ?? values.openaiFilesApiKey
    if (this.rotationPending && this.cache) {
      await this.enqueue(async () => {
        if (!this.rotationPending || !this.cache) return
        await this.writeAll({ ...this.cache }).catch(() => undefined)
      })
    }
    return value?.trim() || null
  }

  async hasOpenAiApiKey() {
    return (await this.getOpenAiApiKey()) !== null
  }


  setOpenAiApiKey(value: string) {
    return this.enqueue(async () => {
      if (!(await this.status()).available) throw new Error("Secure OS credential storage is unavailable.")
      const current = await this.readAll()
      if (this.cache === null) throw new Error("Secure credential state is unavailable; refusing to overwrite it.")
      const next = { ...current }
      const trimmed = value.trim()
      // Normalize legacy dual-key stores on the next explicit credential
      // mutation. There must be exactly one durable OXP OpenAI credential.
      delete next.openaiFilesApiKey
      if (trimmed) next.openaiApiKey = trimmed
      else delete next.openaiApiKey
      await this.writeAll(next)
    })
  }

  clearOpenAiApiKey() {
    return this.setOpenAiApiKey("")
  }

  resetUnreadable() {
    return this.enqueue(async () => {
      if (!(await this.status()).available) throw new Error("Secure OS credential storage is unavailable.")
      if (!this.unreadable) await this.readAll()
      if (!this.unreadable) return false

      // This is the explicit destructive recovery path. Ordinary mutation stays
      // fail-closed so a transient decrypt failure can never erase ciphertext.
      // Invalidate any overlapping read before removing the unreadable blob.
      this.generation += 1
      this.cache = null
      this.rotationPending = false
      await fs.rm(this.file, { force: true })
      this.cache = {}
      this.unreadable = false
      return true
    })
  }

  deleteAll() {
    return this.enqueue(async () => {
      // Invalidate before touching the filesystem so an already-running
      // decrypt cannot republish stale plaintext after deletion wins.
      this.generation += 1
      this.cache = null
      this.rotationPending = false
      await fs.rm(this.file, { force: true })
      this.cache = {}
      this.unreadable = false
    })
  }
}
