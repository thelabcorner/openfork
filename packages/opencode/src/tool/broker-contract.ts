import { createHash } from "node:crypto"
import { Schema } from "effect"

export const Parameter = Schema.optional(Schema.String).annotate({
  description: "Current contract returned by describe; required for call.",
})

type Descriptor = {
  broker: string
  target: string
  description: string
  schema: unknown
}

type DescriptorInput = Descriptor & {
  targetField: string
  argsField?: string
}

function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

/**
 * Stateless proof that a model has been shown the exact hidden descriptor it is
 * about to invoke. The token intentionally binds both instructions and schema:
 * changing either invalidates stale context without growing the permanent tool
 * manifest or keeping per-session broker state.
 */
export function make(input: Descriptor) {
  const digest = createHash("sha256")
    .update(
      canonical({
        version: 1,
        broker: input.broker,
        target: input.target,
        description: input.description,
        schema: input.schema,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24)
  return `broker-v1:${digest}`
}

/**
 * Canonical model-facing descriptor for every hidden-schema broker. Keep this
 * envelope uniform even when a broker retains legacy aliases such as
 * `parameters` or `args` for readability/backward compatibility.
 */
export function describe(input: DescriptorInput) {
  const contract = make(input)
  return {
    protocol: "broker-descriptor-v1" as const,
    broker: input.broker,
    target: input.target,
    description: input.description,
    inputSchema: input.schema,
    contract,
    invocation: {
      action: "call" as const,
      targetField: input.targetField,
      target: input.target,
      contractField: "contract" as const,
      argsField: input.argsField ?? "args",
    },
    rules: [
      "Echo the contract exactly on the corresponding call.",
      "Pass arguments as a JSON object satisfying inputSchema; never pass the schema itself or placeholder text as arguments.",
      "If the contract is rejected, describe the target again because its instructions or schema changed.",
    ] as const,
  }
}

export function violation(input: Descriptor & { contract?: string; discovery: string }) {
  const expected = make({
    broker: input.broker,
    target: input.target,
    description: input.description,
    schema: input.schema,
  })
  if (input.contract === expected) return undefined
  return `${input.broker} cannot call ${input.target} without its current descriptor contract. ${input.discovery} first, then retry action=call with the exact returned contract. Do not guess, omit, or reuse a contract from another capability.`
}

export function assertCurrent(input: Descriptor & { contract?: string; discovery: string }) {
  const issue = violation(input)
  if (issue) throw new Error(issue)
  return input.contract!
}

export * as BrokerContract from "./broker-contract"
