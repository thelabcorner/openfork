export * as SessionError from "./session-error"

const MAX_MESSAGE_LENGTH = 1_024
const MAX_FIELD_LENGTH = 128

export interface Summary {
  readonly name: string
  readonly message: string
  readonly kind?: string
  readonly providerID?: string
  readonly accountID?: string
  readonly modelID?: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(...values: unknown[]) {
  const value = values.find((item): item is string => typeof item === "string" && item.trim().length > 0)
  return value?.trim()
}

function bounded(value: string | undefined, limit: number) {
  if (!value) return undefined
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function safeMessage(value: string) {
  return value
    .replace(/(\bauthorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/gi, "$1[REDACTED]")
}

/**
 * Extract a bounded, allow-listed summary from arbitrary session.error payloads.
 * Never serializes stack, causes, headers, response bodies, or arbitrary fields.
 */
export function summary(error: unknown): Summary {
  const root = object(error)
  const data = object(root?.data)
  const provider = object(root?.provider) ?? object(data?.provider)
  const account = object(root?.account) ?? object(data?.account)
  const model = object(root?.model) ?? object(data?.model)
  const rawName = text(root?.name)
  const name = bounded((rawName && rawName !== "Error" ? rawName : text(root?._tag, rawName)) ?? "Error", MAX_FIELD_LENGTH) ?? "Error"
  const rawMessage = text(root?.message, data?.message, typeof error === "string" ? error : undefined) ?? name
  const message = bounded(safeMessage(rawMessage), MAX_MESSAGE_LENGTH) ?? name
  const kind = bounded(text(root?.kind, data?.kind, root?.type, data?.type, root?.code, data?.code), MAX_FIELD_LENGTH)
  const providerID = bounded(
    text(root?.providerID, data?.providerID, root?.provider, data?.provider, provider?.providerID, provider?.id, provider?.name),
    MAX_FIELD_LENGTH,
  )
  const accountID = bounded(text(root?.accountID, data?.accountID, account?.accountID, account?.id), MAX_FIELD_LENGTH)
  const modelID = bounded(text(root?.modelID, data?.modelID, root?.model, data?.model, model?.modelID, model?.id), MAX_FIELD_LENGTH)

  return {
    name,
    message,
    ...(kind ? { kind } : {}),
    ...(providerID ? { providerID } : {}),
    ...(accountID ? { accountID } : {}),
    ...(modelID ? { modelID } : {}),
  }
}

/** Stable JSON for consumers that need a single log-safe string. */
export function serialize(error: unknown) {
  return JSON.stringify(summary(error))
}
