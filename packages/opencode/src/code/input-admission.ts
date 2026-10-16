const encoder = new TextEncoder()

export const MAX_SOURCE_BYTES = 128 * 1024
export const MAX_INPUT_BYTES = 512 * 1024
export const MAX_REQUEST_BYTES = 768 * 1024

export type Accepted = {
  readonly ok: true
  readonly sourceBytes?: number
  readonly inputBytes?: number
  readonly requestBytes: number
}

export type Rejected = {
  readonly ok: false
  readonly reason: string
  readonly witness: Record<string, unknown>
}

export type Decision = Accepted | Rejected

const bytes = (value: string) => encoder.encode(value).byteLength

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const serializedBytes = (value: unknown): number | undefined => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : bytes(text)
  } catch {
    return undefined
  }
}

const reject = (
  action: unknown,
  reason: string,
  sizes: { sourceBytes?: number; inputBytes?: number; requestBytes?: number },
): Rejected => ({
  ok: false,
  reason,
  witness: {
    action: typeof action === "string" ? action : "unknown",
    rejected: true,
    reason,
    ...(sizes.sourceBytes === undefined ? {} : { sourceBytes: sizes.sourceBytes }),
    ...(sizes.inputBytes === undefined ? {} : { inputBytes: sizes.inputBytes }),
    ...(sizes.requestBytes === undefined ? {} : { requestBytes: sizes.requestBytes }),
  },
})

/**
 * Durable/provider-root Code admission policy.
 *
 * This does not attempt to protect provider memory (the provider already
 * materialized the JSON value); it prevents unbounded source/input bytes from
 * becoming durable ToolPart state and keeps the execution validator aligned.
 */
export function inspect(value: unknown): Decision {
  const input = record(value)
  if (!input) return reject(undefined, "Code request must be a JSON object.", {})

  const action = input.action
  const requestBytes = serializedBytes(input)
  if (requestBytes === undefined) {
    return reject(action, "Code request must be JSON-serializable.", {})
  }
  if (requestBytes > MAX_REQUEST_BYTES) {
    return reject(
      action,
      `Code request exceeds the ${MAX_REQUEST_BYTES}-byte durable request limit.`,
      { requestBytes },
    )
  }

  const sourceBytes = typeof input.code === "string" ? bytes(input.code) : undefined
  if (sourceBytes !== undefined && sourceBytes > MAX_SOURCE_BYTES) {
    return reject(
      action,
      `Code source exceeds the ${MAX_SOURCE_BYTES}-byte durable source limit.`,
      { sourceBytes, requestBytes },
    )
  }

  const inputBytes = Object.hasOwn(input, "input") ? serializedBytes(input.input) : undefined
  if (Object.hasOwn(input, "input") && inputBytes === undefined) {
    return reject(action, "Code invocation input must be JSON-serializable.", {
      sourceBytes,
      requestBytes,
    })
  }
  if (inputBytes !== undefined && inputBytes > MAX_INPUT_BYTES) {
    return reject(
      action,
      `Code invocation input exceeds the ${MAX_INPUT_BYTES}-byte durable input limit.`,
      { sourceBytes, inputBytes, requestBytes },
    )
  }

  return {
    ok: true,
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
    ...(inputBytes === undefined ? {} : { inputBytes }),
    requestBytes,
  }
}

export function durableInput(value: Record<string, unknown>): Record<string, unknown> {
  const decision = inspect(value)
  return decision.ok ? value : decision.witness
}
