import { describe, expect, test } from "bun:test"
import { createTelegramBotAPI, TelegramBotError, telegramPairingUrl, validateBotToken } from "../../src/notification/telegram/transport"

const token = "123456789:AAABBBCCCDDDEEEFFFGGGHHHIII_JJJ"
const body = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("generic Telegram delivery transport", () => {
  test("validates token before any I/O", () => {
    expect(validateBotToken(token)).toBe(true)
    expect(validateBotToken("123456:bad")).toBe(false)
    expect(() => createTelegramBotAPI("invalid!")).toThrow(TelegramBotError)
    expect(telegramPairingUrl("OpenForkAlerts_bot", "abcdefghijklmnopqrstuvwx")).toBe(
      "https://t.me/OpenForkAlerts_bot?start=abcdefghijklmnopqrstuvwx",
    )
    expect(() => telegramPairingUrl("bad/name", "abcdefghijklmnopqrstuvwx")).toThrow()
  })

  test("identity is verified and the response exposes no token", async () => {
    let calls = 0
    const bot = createTelegramBotAPI(token, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls++
        expect(String(url)).toContain("/getMe")
        expect(init?.method).toBe("POST")
        expect(init?.redirect).toBe("error")
        return body({ ok: true, result: { id: 77, is_bot: true, username: "OpenForkAlerts_bot" } })
      }) as unknown as typeof fetch,
    })
    expect(await bot.identity()).toEqual({ id: 77, username: "OpenForkAlerts_bot" })
    expect(calls).toBe(1)
  })

  test("pairs only a private /start with exact nonce; advances update offset", async () => {
    const nonce = "abcdefghijklmnopqrstuvwx"
    const bot = createTelegramBotAPI(token, {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).allowed_updates).toEqual(["message"])
        return body({
          ok: true,
          result: [
            { update_id: 12, message: { text: `/start ${nonce}`, chat: { id: -100, type: "supergroup" } } },
            { update_id: 13, message: { text: "/start wrong", chat: { id: 1, type: "private" } } },
            {
              update_id: 14,
              message: { text: `/start ${nonce}`, chat: { id: 42, type: "private", username: "developer" } },
            },
          ],
        })
      }) as unknown as typeof fetch,
    })
    expect(await bot.readPairing(nonce, 10)).toEqual({
      chat: { id: 42, username: "developer" },
      offset: 15,
    })
  })

  test("does not leak bearer token on network failure or Telegram flood control", async () => {
    const failure = createTelegramBotAPI(token, {
      fetch: (async () => {
        throw new Error(`network failed https://api.telegram.org/bot${token}/getMe`)
      }) as unknown as typeof fetch,
    })
    try {
      await failure.identity()
      throw new Error("expected failure")
    } catch (error) {
      expect(String(error)).not.toContain(token)
      expect(error).toBeInstanceOf(TelegramBotError)
    }

    const limited = createTelegramBotAPI(token, {
      fetch: (async () =>
        body({ ok: false, error_code: 429, parameters: { retry_after: 12 }, description: "flood" }, 429)) as unknown as typeof fetch,
    })
    await expect(limited.sendText(42, "Hello")).rejects.toMatchObject({
      code: "telegram",
      status: 429,
      retryAfterSeconds: 12,
    })
  })

  test("sanitizes unbounded responses and validates send acknowledgment", async () => {
    const invalid = createTelegramBotAPI(token, {
      fetch: (async () => new Response("a".repeat(65_536))) as unknown as typeof fetch,
    })
    await expect(invalid.identity()).rejects.toMatchObject({ code: "invalid-response" })
    const bot = createTelegramBotAPI(token, {
      fetch: (async () => body({ ok: true, result: { message_id: 333 } })) as unknown as typeof fetch,
    })
    expect(await bot.sendText(42, "Quota reset confirmed")).toEqual({ messageId: 333 })
  })
})
