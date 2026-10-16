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
  return violationExpected({
    broker: input.broker,
    target: input.target,
    expected,
    contract: input.contract,
    discovery: input.discovery,
  })
}

/**
 * Compare with a contract previously minted from the exact trusted descriptor.
 * Callers MUST supply an owner-held expected value, never a caller-controlled
 * token. Avoids re-canonicalizing and SHA-256 hashing large immutable schemas
 * on each executable broker call; mismatches retain the original repair text.
 */
export function violationExpected(input: {
  readonly broker: string
  readonly target: string
  readonly expected: string
  readonly contract?: string
  readonly discovery: string
}) {
  if (input.contract === input.expected) return undefined
  return `${input.broker} cannot call ${input.target} without its current descriptor contract. ${input.discovery} first, then retry action=call with the exact returned contract. Do not guess, omit, or reuse a contract from another capability.`
}

export function assertCurrent(input: Descriptor & { contract?: string; discovery: string }) {
  const issue = violation(input)
  if (issue) throw new Error(issue)
  return input.contract!
}

/**
 * Shared cross-surface discovery envelope.
 *
 * Every discovery surface keeps its own describe output and additionally
 * projects this envelope, so consumers can rely on one vocabulary without
 * collapsing dispatch: the lazy `tool` broker, `code` capability refs, MCP
 * projections, and domain-owned catalogs such as `github catalog/describe`.
 * See docs/plans/tool-description-discovery-unification.md.
 */
export type CanonicalDescriptor = {
  protocol: "capability-descriptor-v1"
  /** Stable selector: a capability ref, `tool:<id>`, or a domain ref such as `github:api:...`. */
  ref: string
  /** Owner-defined kind, e.g. "tool", "native", "saved", "github-command", "github-api", "github-graphql". */
  kind: string
  description: string
  inputSchema: unknown
  invocation: {
    /** Tool to call (broker id or domain tool id). */
    tool: string
    /** Action value to pass to that tool. */
    action: string
    /** Delegated target selector, when invocation routes through a broker. */
    target?: string
    /** Field carrying the call arguments. */
    argsField: string
    /** Contract field name, when the target requires a describe-first contract. */
    contractField?: string
    /** Short owner-specific hint, e.g. an example call shape. */
    hint?: string
  }
}

export function toCanonicalDescriptor(input: {
  ref: string
  kind: string
  description: string
  inputSchema: unknown
  invocation: CanonicalDescriptor["invocation"]
}): CanonicalDescriptor {
  return {
    protocol: "capability-descriptor-v1",
    ...input,
  }
}

/** Project one `describe` envelope onto the shared discovery vocabulary. */
export function fromBrokerDescriptor(descriptor: ReturnType<typeof describe>): CanonicalDescriptor {
  return toCanonicalDescriptor({
    ref: `${descriptor.broker}:${descriptor.target}`,
    kind: "tool",
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    invocation: {
      tool: descriptor.broker,
      action: descriptor.invocation.action,
      target: descriptor.invocation.target,
      argsField: descriptor.invocation.argsField,
      contractField: descriptor.invocation.contractField,
    },
  })
}

/**
 * Project any capability registration (native, lazy, MCP, MCP-resource, or
 * saved) onto the shared envelope. Structural input keeps this module free of
 * the registration runtime type; every Registration satisfies it.
 */
export function fromRegistration(entry: {
  identity: { ref: string }
  kind: string
  description: string
  inputSchema: unknown
}): CanonicalDescriptor {
  return toCanonicalDescriptor({
    ref: entry.identity.ref,
    kind: entry.kind,
    description: entry.description,
    inputSchema: entry.inputSchema,
    invocation: {
      tool: "code",
      action: "run",
      argsField: "code",
      hint: "code.run: await call(ref, input); lazy natives also accept tool call after describe; saved tools also accept code.call",
    },
  })
}

export * as BrokerContract from "./broker-contract"
