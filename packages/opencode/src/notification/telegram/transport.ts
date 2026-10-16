/**
 * Minimal Telegram Bot API transport for all OpenFork notification services.
 * No bot framework, webhook server, inbound command handlers or long-lived socket.
 * The only permitted Telegram origin is api.telegram.org.
 */
export type TelegramIdentity = { readonly id: number; readonly username: string }
export type TelegramPrivateChat = {
  readonly id: number
  readonly username?: string
  readonly firstName?: string
}
export type TelegramPairingResult = { readonly chat: TelegramPrivateChat; readonly offset: number }

type TelegramResponse<T> = {
  readonly ok?: boolean
  readonly result?: T
  readonly description?: string
  readonly error_code?: number
  readonly parameters?: { readonly retry_after?: number }
}
type TelegramMessage = {
  readonly text?: string
  readonly chat?: { readonly id?: number; readonly type?: string; readonly username?: string; readonly first_name?: string }
}
type TelegramUpdate = { readonly update_id?: number; readonly message?: TelegramMessage }

const TOKEN = /^[0-9]{5,15}:[A-Za-z0-9_-]{20,}$/
const USERNAME = /^[A-Za-z0-9_]{5,32}$/
const MAX_BODY_BYTES = 64 * 1024
const TIMEOUT_MS = 12_000

export class TelegramBotError extends Error {
  readonly code: "invalid-token" | "telegram" | "timeout" | "invalid-response"
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(code: TelegramBotError["code"], message: string, details: { status?: number; retryAfterSeconds?: number } = {}) {
    super(message)
    this.name = "TelegramBotError"
    this.code = code
    this.status = details.status
    this.retryAfterSeconds = details.retryAfterSeconds
  }
}

export function validateBotToken(token: string): boolean {
  return TOKEN.test(token)
}

export function telegramPairingUrl(username: string, nonce: string): string {
  if (!USERNAME.test(username) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
    throw new TelegramBotError("invalid-response", "Invalid pairing identity")
  }
  return `https://t.me/${username}?start=${nonce}`
}

async function boundedJSON(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new TelegramBotError("invalid-response", "Telegram response exceeded size limit")
  }
  if (!response.body) throw new TelegramBotError("invalid-response", "Telegram response is empty")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) throw new TelegramBotError("invalid-response", "Telegram response exceeded size limit")
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as TelegramResponse<unknown>
  } catch {
    throw new TelegramBotError("invalid-response", "Telegram returned malformed JSON")
  }
}

export function createTelegramBotAPI(
  token: string,
  options?: { readonly fetch?: typeof fetch; readonly timeoutMs?: number },
) {
  if (!validateBotToken(token)) throw new TelegramBotError("invalid-token", "Invalid Telegram bot token")
  const client = options?.fetch ?? fetch
  const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? TIMEOUT_MS, 500), 60_000)

  async function call<T>(method: "getMe" | "getUpdates" | "sendMessage", payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await client(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      })
      const body = await boundedJSON(response)
      if (!response.ok || body.ok !== true || body.result === undefined) {
        const status = Number.isFinite(body.error_code) ? body.error_code : response.status
        const retry = body.parameters?.retry_after
        throw new TelegramBotError("telegram", `Telegram request failed (${status})`, {
          status,
          ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0
            ? { retryAfterSeconds: Math.min(3600, retry) }
            : {}),
        })
      }
      return body.result as T
    } catch (error) {
      if (error instanceof TelegramBotError) throw error
      if (controller.signal.aborted) throw new TelegramBotError("timeout", "Telegram request timed out")
      // Fetch exceptions sometimes embed the full request URL (including the
      // bearer token). Never allow those errors across logging/UI boundaries.
      throw new TelegramBotError("telegram", "Telegram network request failed")
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async identity(): Promise<TelegramIdentity> {
      const result = await call<{ id?: unknown; is_bot?: unknown; username?: unknown }>("getMe", {})
      if (
        result.is_bot !== true ||
        !Number.isSafeInteger(result.id) ||
        typeof result.username !== "string" ||
        !USERNAME.test(result.username)
      ) {
        throw new TelegramBotError("invalid-response", "Telegram did not return a valid bot identity")
      }
      return { id: result.id as number, username: result.username }
    },

    /** Only call while an explicit Settings pairing ceremony is pending. */
    async readPairing(nonce: string, offset: number): Promise<TelegramPairingResult | { offset: number }> {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !Number.isSafeInteger(offset) || offset < 0) {
        throw new TelegramBotError("invalid-response", "Invalid Telegram pairing state")
      }
      const result = await call<unknown>("getUpdates", {
        offset,
        limit: 50,
        timeout: 0,
        allowed_updates: ["message"],
      })
      if (!Array.isArray(result)) throw new TelegramBotError("invalid-response", "Telegram returned invalid updates")
      let nextOffset = offset
      let found: TelegramPrivateChat | undefined
      for (const item of result as TelegramUpdate[]) {
        if (!Number.isSafeInteger(item?.update_id) || item.update_id! < 0) continue
        nextOffset = Math.max(nextOffset, item.update_id! + 1)
        const message = item.message
        if (!message || message.text !== `/start ${nonce}`) continue
        if (message.chat?.type !== "private" || !Number.isSafeInteger(message.chat.id)) continue
        if (found) continue
        found = {
          id: message.chat.id!,
          ...(typeof message.chat.username === "string" ? { username: message.chat.username } : {}),
          ...(typeof message.chat.first_name === "string" ? { firstName: message.chat.first_name } : {}),
        }
      }
      return found ? { chat: found, offset: nextOffset } : { offset: nextOffset }
    },

    async sendText(chatId: number, text: string): Promise<{ messageId: number }> {
      if (!Number.isSafeInteger(chatId) || !text || text.length > 4096) {
        throw new TelegramBotError("invalid-response", "Invalid Telegram destination or message")
      }
      const result = await call<{ message_id?: unknown }>("sendMessage", {
        chat_id: chatId,
        text,
        disable_notification: false,
        link_preview_options: { is_disabled: true },
      })
      if (!Number.isSafeInteger(result.message_id)) {
        throw new TelegramBotError("invalid-response", "Telegram did not confirm a message ID")
      }
      return { messageId: result.message_id as number }
    },
  }
}
