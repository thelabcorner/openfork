import type { ServerSDK } from "@/context/server-sdk"
import type { TelegramSubscription } from "./telegram-model"

export type TelegramHubStatus = {
  enabled: boolean
  configured: boolean
  connected: boolean
  botUsername?: string
  chatLabel?: string
  pairingUrl?: string
  pairingExpiresAt?: number
  owner: boolean
  services: { id: string; title: string; enabled: boolean }[]
  error?: string
  lastAttemptAt?: number
  lastSuccessAt?: number
}

export type TelegramQuotaSettings = {
  enabled: boolean
  subscriptions: TelegramSubscription[]
  scheduled: number
}

/**
 * First-party generated SDK is the one HTTP authority: reuse its server
 * selection, authentication, base URL, fetch implementation and error handling.
 * No duplicate hand-written HTTP client or project/Instance context.
 */
export async function telegramRequest(
  sdk: ServerSDK,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: "" | "/bot" | "/pairing" | "/pairing/check" | "/test",
  body?: unknown,
): Promise<TelegramHubStatus> {
  const telegram = sdk.client.telegram
  let value: unknown
  if (method === "GET" && endpoint === "") {
    value = (await telegram.status({ throwOnError: true })).data
  } else if (method === "PATCH" && endpoint === "") {
    const input = body as { enabled: boolean }
    value = (await telegram.update({ enabled: input.enabled }, { throwOnError: true })).data
  } else if (method === "POST" && endpoint === "/bot") {
    const input = body as { token: string }
    value = (await telegram.configure({ token: input.token }, { throwOnError: true })).data
  } else if (method === "DELETE" && endpoint === "/bot") {
    value = (await telegram.disconnect({ throwOnError: true })).data
  } else if (method === "POST" && endpoint === "/pairing") {
    value = (await telegram.beginPairing({ throwOnError: true })).data
  } else if (method === "POST" && endpoint === "/pairing/check") {
    value = (await telegram.checkPairing({ throwOnError: true })).data
  } else if (method === "POST" && endpoint === "/test") {
    value = (await telegram.test({ throwOnError: true })).data
  } else {
    throw new Error("Unknown Telegram hub operation")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telegram response")
  const data = value as Record<string, unknown>
  if (
    typeof data.enabled !== "boolean" || typeof data.configured !== "boolean" ||
    typeof data.connected !== "boolean" || !Array.isArray(data.services)
  ) throw new Error("Invalid Telegram status")
  return data as TelegramHubStatus
}

export async function telegramQuotaRequest(
  sdk: ServerSDK,
  method: "GET" | "PATCH",
  body?: { enabled: boolean; subscriptions: readonly TelegramSubscription[] },
): Promise<TelegramQuotaSettings> {
  const telegram = sdk.client.telegram
  const value: unknown = method === "GET"
    ? (await telegram.quotaStatus({ throwOnError: true })).data
    : (await telegram.quotaUpdate({
        enabled: body?.enabled ?? false,
        subscriptions: [...(body?.subscriptions ?? [])],
      }, { throwOnError: true })).data

  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid quota notification settings")
  const data = value as Record<string, unknown>
  if (typeof data.enabled !== "boolean" || !Array.isArray(data.subscriptions) ||
      typeof data.scheduled !== "number") throw new Error("Invalid quota notification settings")
  return data as TelegramQuotaSettings
}
