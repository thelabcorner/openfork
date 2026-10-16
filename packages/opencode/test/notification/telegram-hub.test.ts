import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Auth } from "../../src/auth"
import { TelegramNotificationHub, type NotificationSource } from "../../src/notification/telegram/hub"
import { TelegramBotError, type createTelegramBotAPI } from "../../src/notification/telegram/transport"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-test-"))
  const records = new Map<string, string>()
  const auth = {
    get(key: string) { return Effect.succeed(records.has(key) ? { type: "api" as const, key: records.get(key)! } : undefined) },
    set(key: string, value: { type: "api"; key: string }) { records.set(key, value.key); return Effect.succeed(undefined) },
    remove(key: string) { records.delete(key); return Effect.succeed(undefined) },
  } as unknown as Auth.Interface
  return {
    dir,
    auth,
    stateFile: join(dir, "telegram.json"),
    ownerFile: join(dir, "telegram.lock"),
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}

describe("generic Telegram notification hub", () => {
  test("with global notifications disabled sources do zero work", async () => {
    const f = await fixture()
    let scans = 0
    let requests = 0
    const source: NotificationSource = {
      id: "quota", title: "Quota resets",
      initialize: async () => undefined,
      active: () => true,
      collect: async () => { scans++; return [] },
      clear: async () => undefined,
    }
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile,
      api: (() => { requests++; throw new Error("transport should be dormant") }) as typeof createTelegramBotAPI,
    })
    try {
      await hub.initialize()
      expect((await hub.status()).enabled).toBe(false)
      expect((await hub.status()).services).toEqual([{ id: "quota", title: "Quota resets", enabled: true }])
      await new Promise((r) => setTimeout(r, 30))
      expect(scans).toBe(0)
      expect(requests).toBe(0)
    } finally { hub.dispose(); await f.dispose() }
  })

  test("uses one verified private chat, one transport, and durable at-most-once delivery across restart", async () => {
    const f = await fixture()
    let sends = 0
    let confirmations = 0
    let collected = 0
    const source: NotificationSource = {
      id: "quota", title: "Quota resets",
      initialize: async () => undefined,
      active: () => true,
      collect: async () => { collected++; return [{ id: "quota-event-1", text: "Quota reset confirmed" }] },
      clear: async () => undefined,
      acknowledge: async () => { confirmations++ },
      nextPollDelayMs: () => 60 * 60_000,
    }
    const fakeApi = ((_token: string) => ({
      identity: async () => ({ id: 99, username: "OpenForkBot" }),
      readPairing: async (_nonce: string, offset: number) => ({ chat: { id: 123, firstName: "Test" }, offset: offset + 1 }),
      sendText: async (chatId: number, text: string) => {
        expect(chatId).toBe(123)
        expect(text).toContain("Quota reset")
        sends++
        return { messageId: sends }
      },
    })) as unknown as typeof createTelegramBotAPI
    const options = { stateFile: f.stateFile, ownerFile: f.ownerFile, api: fakeApi, intervalMs: 60 * 60_000 }
    const hub = new TelegramNotificationHub(f.auth, [source], options)
    try {
      await hub.initialize()
      await expect(hub.setEnabled(true)).rejects.toThrow()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      expect((await hub.beginPairing()).pairingUrl).toContain("t.me/OpenForkBot?start=")
      expect((await hub.checkPairing()).connected).toBe(true)
      await hub.setEnabled(true)
      for (let i = 0; i < 60 && sends < 1; i++) await new Promise((r) => setTimeout(r, 10))
      expect(sends).toBe(1)
      expect(confirmations).toBe(1)
      expect(collected).toBe(1)
      expect(Object.keys((JSON.parse(await readFile(f.stateFile, "utf8")) as { delivered: object }).delivered)).toHaveLength(1)
    } finally {
      hub.dispose()
      // on Windows the owner-file release is deliberately asynchronous
      await new Promise((r) => setTimeout(r, 50))
    }

    const resumed = new TelegramNotificationHub(f.auth, [source], options)
    try {
      await resumed.initialize()
      for (let i = 0; i < 60 && collected < 2; i++) await new Promise((r) => setTimeout(r, 10))
      expect(collected).toBeGreaterThanOrEqual(2)
      expect(sends).toBe(1)
      expect(confirmations).toBeGreaterThanOrEqual(2)
    } finally { resumed.dispose(); await new Promise((r) => setTimeout(r, 50)); await f.dispose() }
  })

  test("persists Telegram 429 retry_after and prevents premature repeated sends", async () => {
    const f = await fixture()
    let sends = 0
    const source: NotificationSource = {
      id: "quota", title: "Quota",
      initialize: async () => undefined,
      active: () => true,
      collect: async () => [{ id: "one", text: "Reminder" }],
      clear: async () => undefined,
    }
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 10 }),
      sendText: async () => {
        sends++
        throw new TelegramBotError("telegram", "rate limited", { status: 429, retryAfterSeconds: 2 })
      },
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake, intervalMs: 100,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      await hub.setEnabled(true)
      for (let i = 0; i < 40 && !sends; i++) await new Promise((r) => setTimeout(r, 10))
      expect(sends).toBe(1)
      expect((JSON.parse(await readFile(f.stateFile, "utf8")) as { retryAt: number }).retryAt).toBeGreaterThan(Date.now())
      await hub.refresh()
      await new Promise((r) => setTimeout(r, 120))
      expect(sends).toBe(1)
    } finally { hub.dispose(); await new Promise((r) => setTimeout(r, 30)); await f.dispose() }
  })

  test("Telegram 403 stops automatic delivery until explicitly re-enabled", async () => {
    const f = await fixture()
    let sends = 0
    const source: NotificationSource = {
      id: "quota", title: "Quota",
      initialize: async () => undefined,
      active: () => true,
      collect: async () => [{ id: "one", text: "Reminder" }],
      clear: async () => undefined,
      acknowledge: async () => undefined,
    }
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 10 }),
      sendText: async () => {
        sends++
        throw new TelegramBotError("telegram", "blocked", { status: 403 })
      },
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake, intervalMs: 100,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      await hub.setEnabled(true)
      for (let i = 0; i < 40 && !sends; i++) await new Promise((r) => setTimeout(r, 10))
      await new Promise((r) => setTimeout(r, 20))
      expect((await hub.status()).enabled).toBe(false)
      expect((await hub.status()).owner).toBe(false)
      expect(sends).toBe(1)
    } finally { hub.dispose(); await new Promise((r) => setTimeout(r, 30)); await f.dispose() }
  })

  test("disabling during a pending source scan prevents a late Telegram send", async () => {
    const f = await fixture()
    let entered!: () => void
    let unblock!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const pending = new Promise<void>((resolve) => { unblock = resolve })
    let sends = 0
    const source: NotificationSource = {
      id: "quota", title: "Quota",
      initialize: async () => undefined,
      active: () => true,
      clear: async () => undefined,
      collect: async () => {
        entered()
        await pending
        return [{ id: "quota-race", text: "old event" }]
      },
    }
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 10 }),
      sendText: async () => { sends++; return { messageId: 1 } },
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake, intervalMs: 100,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      await hub.setEnabled(true)
      await began
      await hub.setEnabled(false)
      unblock()
      await new Promise((r) => setTimeout(r, 75))
      expect(sends).toBe(0)
      expect((await hub.status()).enabled).toBe(false)
    } finally {
      unblock?.()
      hub.dispose()
      await new Promise((r) => setTimeout(r, 25))
      await f.dispose()
    }
  })

  test("rapid disable and re-enable waits for its own old owner lock release", async () => {
    const f = await fixture()
    const source: NotificationSource = {
      id: "quota", title: "Quota",
      initialize: async () => undefined,
      active: () => true,
      collect: async () => [],
      clear: async () => undefined,
    }
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 10 }),
      sendText: async () => ({ messageId: 1 }),
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake, intervalMs: 60_000,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      await hub.setEnabled(true)
      expect((await hub.status()).owner).toBe(true)
      await hub.setEnabled(false)
      await hub.setEnabled(true)
      expect((await hub.status()).owner).toBe(true)
      expect((JSON.parse(await readFile(f.ownerFile, "utf8")) as { nonce: string }).nonce).toMatch(/^[a-f0-9]{40}$/)
    } finally {
      hub.dispose()
      await new Promise((r) => setTimeout(r, 25))
      await f.dispose()
    }
  })

  test("stale pairing response cannot reattach a chat after disconnect", async () => {
    const f = await fixture()
    let release!: (value: { chat: { id: number }; offset: number }) => void
    const pending = new Promise<{ chat: { id: number }; offset: number }>((resolve) => { release = resolve })
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => pending,
      sendText: async () => ({ messageId: 1 }),
    })) as unknown as typeof createTelegramBotAPI
    const source: NotificationSource = {
      id: "quota", title: "Quota", initialize: async () => undefined,
      active: () => false, collect: async () => [], clear: async () => undefined,
    }
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      const inflight = hub.checkPairing()
      await hub.disconnect()
      release({ chat: { id: 42 }, offset: 1 })
      await expect(inflight).rejects.toThrow()
      const status = await hub.status()
      expect(status.connected).toBe(false)
      expect(status.configured).toBe(false)
      expect(status.enabled).toBe(false)
    } finally { hub.dispose(); await f.dispose() }
  })

  test("rapid disable then re-enable does not strand its own process lock", async () => {
    const f = await fixture()
    const source: NotificationSource = {
      id: "quota", title: "Quota", initialize: async () => undefined,
      active: () => true, collect: async () => [], clear: async () => undefined,
    }
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 1 }),
      sendText: async () => ({ messageId: 1 }),
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [source], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake,
      intervalMs: 600_000,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      await hub.setEnabled(true)
      expect((await hub.status()).owner).toBe(true)
      await hub.setEnabled(false)
      await hub.setEnabled(true)
      expect((await hub.status()).owner).toBe(true)
      expect((await hub.status()).error).toBeUndefined()
    } finally {
      hub.dispose()
      await new Promise((r) => setTimeout(r, 60))
      await f.dispose()
    }
  })

  test("independent services share one bot while retaining isolated delivery identity", async () => {
    const f = await fixture()
    const delivered: string[] = []
    const notices = (id: string): NotificationSource => ({
      id, title: id === "quota" ? "Quota resets" : "Agent events",
      initialize: async () => undefined,
      active: () => true,
      // Deliberately identical event IDs: the generic hub must namespace
      // receipts by source, not incorrectly deduplicate across services.
      collect: async () => [{ id: "same-event", text: id }],
      clear: async () => undefined,
    })
    const sourceQuota = notices("quota")
    const sourceAgent = notices("agent")
    const fake = ((_token: string) => ({
      identity: async () => ({ id: 9, username: "OpenForkBot" }),
      readPairing: async () => ({ chat: { id: 42 }, offset: 1 }),
      sendText: async (_chat: number, text: string) => {
        delivered.push(text)
        return { messageId: delivered.length }
      },
    })) as unknown as typeof createTelegramBotAPI
    const hub = new TelegramNotificationHub(f.auth, [sourceQuota, sourceAgent], {
      stateFile: f.stateFile, ownerFile: f.ownerFile, api: fake,
      intervalMs: 600_000,
    })
    try {
      await hub.initialize()
      await hub.configure("123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ")
      await hub.beginPairing()
      await hub.checkPairing()
      expect((await hub.status()).services).toEqual([
        { id: "quota", title: "Quota resets", enabled: true },
        { id: "agent", title: "Agent events", enabled: true },
      ])
      await hub.setEnabled(true)
      for (let i = 0; i < 60 && delivered.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(delivered).toEqual(["quota", "agent"])
      expect(Object.keys((JSON.parse(await readFile(f.stateFile, "utf8")) as { delivered: object }).delivered)).toHaveLength(2)
    } finally {
      hub.dispose()
      await new Promise((resolve) => setTimeout(resolve, 60))
      await f.dispose()
    }
  })

  test("rejects colliding service registrations", async () => {
    const f = await fixture()
    const source: NotificationSource = {
      id: "quota", title: "Quota", initialize: async () => undefined,
      active: () => false, collect: async () => [], clear: async () => undefined,
    }
    expect(() => new TelegramNotificationHub(f.auth, [source, source])).toThrow()
    await f.dispose()
  })
})
