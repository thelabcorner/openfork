import type { JSONSchema7 } from "@ai-sdk/provider"

export function isBrokerArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Project a compressed broker schema to providers.
 *
 * `args` intentionally stays opaque in the permanent manifest, but opaque args
 * are only safe when the broker also exposes the descriptor-contract handshake.
 * Enforce that invariant here so a future compressed broker cannot accidentally
 * reuse this helper and reintroduce speculative nested calls.
 */
export function withContractedBrokerArgsSchema(schema: JSONSchema7): JSONSchema7 {
  const properties = schema.properties ?? {}
  if (!("contract" in properties)) {
    throw new Error("Compressed broker schemas must expose a descriptor contract before hiding delegated args")
  }
  const current = properties.args
  const args = current && typeof current === "object" && !Array.isArray(current) ? current : {}
  return {
    ...schema,
    properties: {
      ...properties,
      args: {
        ...args,
        type: "object",
      },
    },
  }
}

/**
 * Normalize the argument payload used by provider-facing broker tools.
 *
 * Models normally send a real object, but some providers/models stringify a
 * nested JSON object after reading a dynamically returned schema. Accept that
 * losslessly when possible. Never infer values from documentation placeholders
 * or other strings because the broker does not have enough information to do so
 * safely.
 */
export function normalizeBrokerArgs(
  value: unknown,
  options: {
    broker: string
    allowOmitted?: boolean
  },
): Record<string, unknown> {
  if (value === undefined && options.allowOmitted) return {}
  if (isBrokerArgs(value)) return value

  if (typeof value === "string") {
    const text = value.trim()
    if (text.startsWith("{") && text.endsWith("}")) {
      try {
        const parsed = JSON.parse(text)
        if (isBrokerArgs(parsed)) return parsed
      } catch {
        // Fall through to the actionable broker error below.
      }
    }
  }

  throw new Error(
    `${options.broker} args must be a JSON object for action=call; do not pass schema text or placeholder strings from describe output`,
  )
}
