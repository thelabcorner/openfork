import { createHash } from "node:crypto"
import type { JSONSchema7 } from "@ai-sdk/provider"
import * as Capability from "@/tool/capability"
import { ToolJsonSchema } from "@/tool/json-schema"
import type { SaveSpec } from "./schema"

export const SAVED_FORMAT = 1 as const
export const SAVED_RUNTIME = "confined" as const

export type SavedScope = Capability.SavedScope

export type Dependency = {
  readonly ref: string
  readonly executionContract: string
  readonly authorityBinding: string
  readonly pinnedHandle?: string
}

export type RevisionEnvelope = {
  readonly format: typeof SAVED_FORMAT
  readonly runtime: typeof SAVED_RUNTIME
  readonly sourceHash: string
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
  readonly dependencies: readonly Dependency[]
}

export type Manifest = RevisionEnvelope & {
  readonly id: string
  readonly description: string
  readonly tags: readonly string[]
  readonly revision: string
  readonly descriptorFingerprint: string
  readonly origin: {
    readonly run: string
    readonly session: string
    readonly message: string
  }
}

export type Derived = {
  readonly source: string
  readonly sourceHash: string
  readonly revision: string
  readonly descriptorFingerprint: string
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
  readonly dependencies: readonly Dependency[]
  readonly envelope: RevisionEnvelope
}

const DEFAULT_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
}

const RESERVED_IDS = new Set([
  "project",
  "global",
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

export class SavedRevisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SavedRevisionError"
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sha256Identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new SavedRevisionError(`${label} must be canonical sha256:<64 lowercase hex>.`)
  }
  return value
}

export function parseDependencies(value: unknown): readonly Dependency[] {
  if (!Array.isArray(value)) throw new SavedRevisionError("Saved revision dependencies must be an array.")
  const result = value.map((item) => {
    const entry = record(item)
    if (
      !entry ||
      typeof entry.ref !== "string" ||
      typeof entry.executionContract !== "string" ||
      typeof entry.authorityBinding !== "string" ||
      (entry.pinnedHandle !== undefined && typeof entry.pinnedHandle !== "string")
    ) {
      throw new SavedRevisionError("Saved revision contains an invalid dependency entry.")
    }
    sha256Identity(entry.executionContract, "Dependency execution contract")
    return {
      ref: entry.ref,
      executionContract: entry.executionContract,
      authorityBinding: entry.authorityBinding,
      ...(entry.pinnedHandle ? { pinnedHandle: entry.pinnedHandle } : {}),
    }
  })
  return Object.freeze(result.sort((a, b) => a.ref.localeCompare(b.ref)))
}

export function parseEnvelope(value: unknown): RevisionEnvelope {
  const input = record(value)
  if (!input || input.format !== SAVED_FORMAT || input.runtime !== SAVED_RUNTIME) {
    throw new SavedRevisionError("Saved revision envelope has an unsupported format/runtime.")
  }
  const inputSchema = jsonSchema(input.inputSchema)
  if (!inputSchema) throw new SavedRevisionError("Saved revision envelope is missing inputSchema.")
  const outputSchema = jsonSchema(input.outputSchema)
  return {
    format: SAVED_FORMAT,
    runtime: SAVED_RUNTIME,
    sourceHash: sha256Identity(input.sourceHash, "Saved source hash"),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    dependencies: parseDependencies(input.dependencies),
  }
}

export function parseManifest(value: unknown): Manifest {
  const input = record(value)
  if (!input) throw new SavedRevisionError("Saved tool manifest must be an object.")
  const id = validateID(String(input.id ?? ""))
  if (
    typeof input.description !== "string" ||
    !Array.isArray(input.tags) ||
    !input.tags.every((item) => typeof item === "string")
  ) {
    throw new SavedRevisionError("Saved tool manifest has invalid descriptor metadata.")
  }
  const origin = record(input.origin)
  if (
    !origin ||
    typeof origin.run !== "string" ||
    typeof origin.session !== "string" ||
    typeof origin.message !== "string"
  ) {
    throw new SavedRevisionError("Saved tool manifest has invalid origin metadata.")
  }
  const envelope = parseEnvelope(input)
  return {
    ...envelope,
    id,
    description: input.description,
    tags: Object.freeze([...input.tags]),
    revision: sha256Identity(input.revision, "Saved executable revision"),
    descriptorFingerprint: sha256Identity(input.descriptorFingerprint, "Saved descriptor fingerprint"),
    origin: {
      run: origin.run,
      session: origin.session,
      message: origin.message,
    },
  }
}

export function validateID(id: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) {
    throw new SavedRevisionError(
      "Saved-tool ID must match ^[a-z][a-z0-9_]{0,63}$.",
    )
  }
  if (RESERVED_IDS.has(id)) {
    throw new SavedRevisionError(`Saved-tool ID '${id}' is reserved.`)
  }
  return id
}

export function canonicalSource(source: string): string {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  return withoutBom.replace(/\r\n?/g, "\n")
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function jsonSchema(value: unknown, fallback?: JSONSchema7): JSONSchema7 | undefined {
  if (value === undefined) return fallback
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SavedRevisionError("Saved-tool schemas must be JSON Schema objects.")
  }
  try {
    return ToolJsonSchema.fromJsonSchema(value as JSONSchema7)
  } catch (cause) {
    throw new SavedRevisionError(
      `Invalid saved-tool JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export function executionContract(registration: Capability.Registration): string {
  return sha256(
    canonicalJson({
      ref: registration.identity.ref,
      inputSchema: registration.inputSchema,
      outputSchema: registration.outputSchema ?? null,
      revision: registration.revision ?? null,
      authorityBinding: registration.authorityBinding,
    }),
  )
}

function assertPortableScope(scope: SavedScope, dependencies: readonly Dependency[]) {
  if (scope !== "global") return
  for (const dependency of dependencies) {
    if (!dependency.pinnedHandle) continue
    let identity: Capability.Identity
    try {
      identity = Capability.identityFromRef(dependency.pinnedHandle)
    } catch {
      throw new SavedRevisionError(`Saved dependency has an invalid pinned handle: ${dependency.pinnedHandle}`)
    }
    if (identity.segments[0] === "project") {
      throw new SavedRevisionError(
        `Global saved tools cannot pin project-scoped saved dependency: ${dependency.ref}`,
      )
    }
  }
}

/**
 * Capture exact execution identities from one frozen root capability snapshot.
 *
 * This intentionally does not apply project/global portability policy; callers
 * may capture once at run time and choose the final saved scope later.
 */
export function captureDependencies(input: {
  readonly refs: readonly string[]
  readonly inventory: Capability.Inventory
}): readonly Dependency[] {
  const result: Dependency[] = []
  for (const ref of [...new Set(input.refs)].sort()) {
    const registration = Capability.lookup(input.inventory, ref)
    if (!registration) {
      throw new SavedRevisionError(`Saved-tool dependency is not in the captured capability snapshot: ${ref}`)
    }
    if (!registration.codeCallable) {
      throw new SavedRevisionError(`Saved-tool dependency is not callable from Code: ${ref}`)
    }
    result.push({
      ref,
      executionContract: executionContract(registration),
      authorityBinding: registration.authorityBinding,
      ...(registration.kind === "saved" ? { pinnedHandle: registration.identity.ref } : {}),
    })
  }
  return Object.freeze(result)
}

export function dependencies(input: {
  readonly refs: readonly string[]
  readonly dynamicCallTarget: boolean
  readonly inventory: Capability.Inventory
  readonly scope: SavedScope
}): readonly Dependency[] {
  if (input.dynamicCallTarget) {
    throw new SavedRevisionError(
      "Saved tools require static capability refs; computed call(...) targets cannot be promoted.",
    )
  }
  const result = captureDependencies({ refs: input.refs, inventory: input.inventory })
  assertPortableScope(input.scope, result)
  return result
}

/**
 * Verify a previously captured dependency envelope against the current frozen
 * root snapshot without silently adopting newer execution contracts.
 */
export function preflightDependencies(input: {
  readonly dependencies: readonly Dependency[]
  readonly inventory: Capability.Inventory
  readonly scope: SavedScope
}): void {
  assertPortableScope(input.scope, input.dependencies)
  for (const dependency of input.dependencies) {
    const registration = Capability.lookup(input.inventory, dependency.ref)
    if (!registration || !registration.codeCallable) {
      throw new SavedRevisionError(
        `Saved-tool dependency is unavailable or not callable: ${dependency.ref}`,
      )
    }
    if (
      executionContract(registration) !== dependency.executionContract ||
      registration.authorityBinding !== dependency.authorityBinding
    ) {
      throw new SavedRevisionError(
        `Saved-tool dependency execution contract changed since the source run: ${dependency.ref}`,
      )
    }
    if (dependency.pinnedHandle && registration.identity.ref !== dependency.pinnedHandle) {
      throw new SavedRevisionError(
        `Pinned saved dependency identity changed since the source run: ${dependency.ref}`,
      )
    }
  }
}

export function derive(input: {
  readonly source: string
  readonly spec: SaveSpec
  readonly dependencies: readonly Dependency[]
}): Derived {
  const id = validateID(input.spec.name)
  const source = canonicalSource(input.source)
  const sourceHash = sha256(source)
  const inputSchema = jsonSchema(input.spec.inputSchema, DEFAULT_INPUT_SCHEMA)!
  const outputSchema = jsonSchema(input.spec.outputSchema)
  const dependencies = Object.freeze(
    [...input.dependencies].sort((a, b) => a.ref.localeCompare(b.ref)),
  )

  const envelope: RevisionEnvelope = {
    format: SAVED_FORMAT,
    runtime: SAVED_RUNTIME,
    sourceHash,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    dependencies,
  }
  const revision = sha256(canonicalJson(envelope))
  const description = input.spec.description ?? `Saved Code tool: ${id}`
  const tags = Object.freeze([...(input.spec.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort())
  const descriptorFingerprint = sha256(
    canonicalJson({
      id,
      description,
      tags,
      revision,
      inputSchema,
      outputSchema: outputSchema ?? null,
    }),
  )

  return {
    source,
    sourceHash,
    revision,
    descriptorFingerprint,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    dependencies,
    envelope,
  }
}

export function manifest(input: {
  readonly derived: Derived
  readonly spec: SaveSpec
  readonly origin: Manifest["origin"]
}): Manifest {
  const id = validateID(input.spec.name)
  return {
    ...input.derived.envelope,
    id,
    description: input.spec.description ?? `Saved Code tool: ${id}`,
    tags: Object.freeze([...(input.spec.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort()),
    revision: input.derived.revision,
    descriptorFingerprint: input.derived.descriptorFingerprint,
    origin: input.origin,
  }
}

export function verify(input: {
  readonly source: string
  readonly envelope: RevisionEnvelope
  readonly expectedRevision: string
}): void {
  const source = canonicalSource(input.source)
  if (sha256(source) !== input.envelope.sourceHash) {
    throw new SavedRevisionError("Saved source hash does not match its revision envelope.")
  }
  const actual = sha256(canonicalJson(input.envelope))
  if (actual !== input.expectedRevision) {
    throw new SavedRevisionError("Saved executable revision does not match its canonical envelope.")
  }
}
