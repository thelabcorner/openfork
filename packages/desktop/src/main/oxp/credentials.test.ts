import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  OxpCredentialStore,
  secureStorageCiphertextIsProtected,
  type SecureStorageAdapter,
} from "./credentials-store"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-credentials-test-"))
  dirs.push(dir)
  return dir
}

function codec(options?: {
  decryptGate?: Promise<void>
  decryptError?: Error
  shouldReEncrypt?: boolean
  encryptCount?: { value: number }
}): SecureStorageAdapter {
  return {
    async isAsyncEncryptionAvailable() {
      return true
    },
    async encryptStringAsync(value) {
      if (options?.encryptCount) options.encryptCount.value += 1
      return Buffer.from(`enc:${value}`, "utf8")
    },
    async decryptStringAsync(value) {
      await options?.decryptGate
      if (options?.decryptError) throw options.decryptError
      const text = value.toString("utf8")
      if (!text.startsWith("enc:")) throw new Error("invalid ciphertext")
      return { result: text.slice(4), shouldReEncrypt: options?.shouldReEncrypt ?? false }
    },
  }
}

async function seed(dir: string, storage: SecureStorageAdapter, value: Record<string, string>) {
  await fs.writeFile(path.join(dir, "oxp-secrets.bin"), await storage.encryptStringAsync(JSON.stringify(value)))
}

describe("OXP secure credential storage", () => {
  test("rejects Chromium basic_text ciphertext on Linux", () => {
    expect(secureStorageCiphertextIsProtected(Buffer.from("v10not-really-protected"), "linux")).toBe(false)
    expect(secureStorageCiphertextIsProtected(Buffer.from([1, 2, 3, 4]), "linux")).toBe(true)
  })

  test("does not apply the Linux basic_text marker rule to native Windows/macOS encryption", () => {
    const marker = Buffer.from("v10ciphertext")
    expect(secureStorageCiphertextIsProtected(marker, "win32")).toBe(true)
    expect(secureStorageCiphertextIsProtected(marker, "darwin")).toBe(true)
  })

  test("serializes concurrent mutations and preserves unknown string fields", async () => {
    const dir = await temp()
    const storage = codec()
    await seed(dir, storage, { openaiApiKey: "old", futureField: "keep-me" })
    const store = new OxpCredentialStore(dir, storage, "win32")

    await Promise.all([store.setOpenAiApiKey("first"), store.setOpenAiApiKey("second")])
    expect(await store.getOpenAiApiKey()).toBe("second")

    const persisted = await storage.decryptStringAsync(await fs.readFile(path.join(dir, "oxp-secrets.bin")))
    expect(JSON.parse(persisted.result)).toEqual({ openaiApiKey: "second", futureField: "keep-me" })
  })

  test("migrates the legacy Files-only credential into the single OXP OpenAI credential domain", async () => {
    const dir = await temp()
    const storage = codec()
    await seed(dir, storage, { openaiFilesApiKey: "legacy-files-key", futureField: "keep-me" })
    const store = new OxpCredentialStore(dir, storage, "win32")

    expect(await store.getOpenAiApiKey()).toBe("legacy-files-key")

    await store.setOpenAiApiKey("shared-key")
    expect(await store.getOpenAiApiKey()).toBe("shared-key")
    const persisted = await storage.decryptStringAsync(await fs.readFile(path.join(dir, "oxp-secrets.bin")))
    expect(JSON.parse(persisted.result)).toEqual({ openaiApiKey: "shared-key", futureField: "keep-me" })
  })

  test("canonical OXP OpenAI credential wins when both canonical and legacy fields exist", async () => {
    const dir = await temp()
    const storage = codec()
    await seed(dir, storage, { openaiApiKey: "canonical", openaiFilesApiKey: "legacy" })
    const store = new OxpCredentialStore(dir, storage, "win32")

    expect(await store.getOpenAiApiKey()).toBe("canonical")
  })

  test("purges the rejected generic credential registry while preserving the purpose-specific OpenAI key", async () => {
    const dir = await temp()
    const storage = codec()
    await seed(dir, storage, {
      openaiApiKey: "purpose-specific-openai",
      credentialIndexV1: JSON.stringify([{ credentialRef: "cred_AAAAAAAAAAAAAAAAAAAAAAAA" }]),
      "credentialSecret:cred_AAAAAAAAAAAAAAAAAAAAAAAA": "obsolete-secret",
      futureField: "keep-me",
    })
    const store = new OxpCredentialStore(dir, storage, "win32")

    expect(await store.getOpenAiApiKey()).toBe("purpose-specific-openai")

    const persisted = await storage.decryptStringAsync(await fs.readFile(path.join(dir, "oxp-secrets.bin")))
    expect(JSON.parse(persisted.result)).toEqual({
      openaiApiKey: "purpose-specific-openai",
      futureField: "keep-me",
    })
  })

  test("delete invalidates an in-flight decrypt so stale plaintext cannot resurrect", async () => {
    const dir = await temp()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seedCodec = codec()
    await seed(dir, seedCodec, { openaiApiKey: "stale-secret" })
    const store = new OxpCredentialStore(dir, codec({ decryptGate: gate }), "win32")

    const read = store.getOpenAiApiKey()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const deletion = store.deleteAll()
    await deletion
    release()

    expect(await read).toBeNull()
    expect(await store.getOpenAiApiKey()).toBeNull()
    await expect(fs.stat(path.join(dir, "oxp-secrets.bin"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("malformed or unreadable ciphertext blocks mutation instead of becoming authoritative empty state", async () => {
    const dir = await temp()
    const file = path.join(dir, "oxp-secrets.bin")
    const original = Buffer.from("protected-but-unreadable")
    await fs.writeFile(file, original)
    let unreadable = 0
    const store = new OxpCredentialStore(
      dir,
      codec({ decryptError: new Error("decrypt failed") }),
      "win32",
      () => unreadable++,
    )

    expect(await store.getOpenAiApiKey()).toBeNull()
    await expect(store.setOpenAiApiKey("replacement")).rejects.toThrow(/refusing to overwrite/i)
    expect(await fs.readFile(file)).toEqual(original)
    expect(unreadable).toBeGreaterThan(0)
  })

  test("explicit unreadable-state reset recovers without weakening ordinary fail-closed mutation", async () => {
    const dir = await temp()
    const file = path.join(dir, "oxp-secrets.bin")
    await fs.writeFile(file, Buffer.from("protected-but-unreadable"))
    const broken = codec({ decryptError: new Error("decrypt failed") })
    const store = new OxpCredentialStore(dir, broken, "win32")

    expect(await store.getOpenAiApiKey()).toBeNull()
    expect(store.credentialState()).toBe("unreadable")
    await expect(store.setOpenAiApiKey("replacement")).rejects.toThrow(/refusing to overwrite/i)

    expect(await store.resetUnreadable()).toBe(true)
    expect(store.credentialState()).toBe("ready")
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })

    await store.setOpenAiApiKey("replacement")
    expect(await store.getOpenAiApiKey()).toBe("replacement")
    const persisted = await codec().decryptStringAsync(await fs.readFile(file))
    expect(JSON.parse(persisted.result)).toEqual({ openaiApiKey: "replacement" })
    expect(await store.resetUnreadable()).toBe(false)
  })

  test("re-encryption rotates the full credential object without dropping unknown fields", async () => {
    const dir = await temp()
    const count = { value: 0 }
    const storage = codec({ shouldReEncrypt: true, encryptCount: count })
    await seed(dir, storage, { openaiApiKey: "secret", futureField: "preserve" })
    const baseline = count.value
    const store = new OxpCredentialStore(dir, storage, "win32")

    expect(await store.getOpenAiApiKey()).toBe("secret")
    expect(count.value).toBeGreaterThan(baseline)
    const persisted = await storage.decryptStringAsync(await fs.readFile(path.join(dir, "oxp-secrets.bin")))
    expect(JSON.parse(persisted.result)).toEqual({ openaiApiKey: "secret", futureField: "preserve" })
  })

  test("a failed mutation does not poison later serialized credential work", async () => {
    const dir = await temp()
    let available = false
    const storage: SecureStorageAdapter = {
      async isAsyncEncryptionAvailable() {
        return available
      },
      async encryptStringAsync(value) {
        return Buffer.from(`enc:${value}`)
      },
      async decryptStringAsync(value) {
        return { result: value.toString("utf8").slice(4), shouldReEncrypt: false }
      },
    }
    const store = new OxpCredentialStore(dir, storage, "win32")

    await expect(store.setOpenAiApiKey("first")).rejects.toThrow(/unavailable/i)
    available = true
    await store.setOpenAiApiKey("second")
    expect(await store.getOpenAiApiKey()).toBe("second")
  })
})
