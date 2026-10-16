import { Schema } from "effect"
import type { Tool } from "@modelcontextprotocol/server"

export interface Definition {
  readonly schema: Schema.Top
  readonly schemaConstraints?: Readonly<Record<string, unknown>>
  /**
   * Explicitly reviewed safe projection for flat multi-action schemas. Only
   * listed actions qualify; no automatic guessing from prose or field names.
   */
  readonly focusActions?: Readonly<Record<string, {
    readonly fields: readonly string[]
    readonly required: readonly string[]
    /** Reviewed JSON Schema conditions for a single focused action. */
    readonly constraints?: Readonly<Record<string, unknown>>
  }>>
}

/**
 * A described capability is loaded on demand, not part of the permanent tool
 * manifest. Preserve *useful* parameter prose instead of erasing it outright.
 *
 * The budget is per descriptor (including reachable $defs), not per property:
 * a large browser/Swarm union cannot inject unbounded annotations into context.
 * Dropping an over-budget hint is preferable to cutting an authorization warning
 * in half. Schema validation keywords are never removed by this budget.
 */
export type GuidanceMode = "compact" | "balanced" | "full"
// Full descriptions for Swarm (including conditional authority rules) fit
// easily within 8 KiB. A 240-character per-field cutoff silently dropped
// useful instructions to save only a few hundred bytes in an on-demand schema.
// Keep the permanent tool manifest compact instead of amputating field advice.
export const BALANCED_GUIDANCE_CHARS = 8_192
export const BALANCED_FIELD_CHARS = 1_024

/**
 * Explicit coverage, not an agent-confidence score. Only annotations present
 * in the projected JSON Schema count; no subjective text-importance heuristic.
 * A zero count means the tool author has not supplied actionable field prose,
 * not that the operation is intrinsically easy to invoke.
 */
export function annotationCoverage(value: unknown): { count: number; characters: number } {
  let count = 0
  let characters = 0
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (!node || typeof node !== "object") return
    for (const [key, item] of Object.entries(node)) {
      if (key === "description" && typeof item === "string") {
        count += 1
        characters += item.length
        continue
      }
      visit(item)
    }
  }
  visit(value)
  return { count, characters }
}

interface GuidanceBudget {
  readonly mode: GuidanceMode
  remaining: number
}

function compact(value: unknown, budget: GuidanceBudget): unknown {
  if (Array.isArray(value)) return value.map((item) => compact(item, budget))
  if (!value || typeof value !== "object") return value
  const out = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => {
        // A property literally named "description" is valid application data
        // (e.g. swarm task.create.description). Only string-valued JSON Schema
        // annotations are expendable help text. Never remove a nested schema
        // property simply because its name happens to be "description".
        if (key !== "description" || typeof item !== "string") return true
        if (budget.mode === "compact" || !item.trim()) return false
        if (budget.mode === "full") return true
        // Preserve the complete meaning. Never truncate mid-warning or mid-rule.
        const length = item.length
        if (length > BALANCED_FIELD_CHARS || length > budget.remaining) return false
        budget.remaining -= length
        return true
      })
      .map(([key, item]) => [key, compact(item, budget)]),
  ) as Record<string, unknown>

  if (Array.isArray(out.anyOf)) {
    // A nullable required parameter must retain its null branch. Filtering
    // null indiscriminately makes a valid runtime call unrepresentable. Effect
    // currently emits the same JSON Schema shape for some optional fields
    // that reject explicit null; that ambiguity must be resolved at the owner,
    // not by silently prohibiting valid nullable values for every consumer.
    const options = out.anyOf
    // Effect emits an exact four-way JSON Schema union for Schema.Number:
    // number plus three non-JSON sentinel strings. Collapse ONLY that exact
    // pattern. A user-defined union such as Number | Literal("NaN") legitimately
    // accepts a sentinel string and must not be collapsed to Number.
    const values = options.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
      const node = item as Record<string, unknown>
      if (Object.keys(node).length === 1 && node.type === "number") return "number"
      if (Object.keys(node).length !== 2 || node.type !== "string" || !Array.isArray(node.enum) || node.enum.length !== 1) return undefined
      return node.enum[0]
    })
    if (
      values.length === 4 &&
      new Set(values).size === 4 &&
      ["number", "NaN", "Infinity", "-Infinity"].every((candidate) => values.includes(candidate))
    ) {
      const { anyOf: _anyOf, ...wrapper } = out
      return { ...wrapper, type: "number" }
    }
    if (options.length === 1) {
      // Optional fields are represented as anyOf[T, null]. Returning only T
      // silently discarded the wrapper's description, default, examples and
      // other annotations — precisely the hints agents need for optional args.
      const { anyOf: _anyOf, ...wrapper } = out
      return { ...wrapper, ...(options[0] as Record<string, unknown>) }
    }
    out.anyOf = options
  }

  if (out.type && Array.isArray(out.allOf)) {
    // JSON Schema allOf is intersection, not last-wins Object.assign. Only
    // flatten truly disjoint keyword fragments; two required/properties sets
    // must remain in allOf or constraints silently disappear.
    const occupied = new Set(Object.keys(out).filter((key) => key !== "allOf"))
    const mergeable = out.allOf.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !("type" in (item as Record<string, unknown>)) &&
        !("anyOf" in (item as Record<string, unknown>)) &&
        !("oneOf" in (item as Record<string, unknown>)) &&
        !("$ref" in (item as Record<string, unknown>)) &&
        Object.keys(item as Record<string, unknown>).every((key) => {
          if (occupied.has(key)) return false
          occupied.add(key)
          return true
        }),
    )
    if (mergeable) {
      for (const item of out.allOf) Object.assign(out, item)
      delete out.allOf
    }
  }

  return out
}

function refs(value: unknown, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) refs(item, found)
    return found
  }
  if (!value || typeof value !== "object") return found
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "$ref" &&
      typeof item === "string" &&
      item.startsWith("#/$defs/")
    ) {
      found.add(item.slice("#/$defs/".length))
      continue
    }
    refs(item, found)
  }
  return found
}

export function inputSchema(schema: Schema.Top, guidance: GuidanceMode = "balanced"): Tool["inputSchema"] {
  const document = Schema.toJsonSchemaDocument(schema, {
    additionalProperties: false,
  })
  const budget: GuidanceBudget = { mode: guidance, remaining: BALANCED_GUIDANCE_CHARS }
  const projected = compact(document.schema, budget) as Record<string, unknown>
  if (
    projected.type === undefined &&
    Array.isArray(projected.anyOf) &&
    projected.anyOf.length > 0 &&
    projected.anyOf.every(
      (branch) =>
        branch !== null &&
        typeof branch === "object" &&
        !Array.isArray(branch) &&
        (branch as Record<string, unknown>).type === "object",
    )
  ) {
    projected.type = "object"
  }

  const definitions = document.definitions as
    | Record<string, unknown>
    | undefined
  const needed = [...refs(projected)]
  if (!definitions || needed.length === 0) {
    return projected as Tool["inputSchema"]
  }

  const defs: Record<string, unknown> = {}
  const pending = [...needed]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const name = pending.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const definition = definitions[name]
    if (definition === undefined) continue
    const compacted = compact(definition, budget)
    defs[name] = compacted
    for (const dependency of refs(compacted)) {
      if (!seen.has(dependency)) pending.push(dependency)
    }
  }
  return { ...projected, $defs: defs } as unknown as Tool["inputSchema"]
}

export function definitionInputSchema(
  definition: Definition,
  guidance: GuidanceMode = "balanced",
): Tool["inputSchema"] {
  const projected = inputSchema(definition.schema, guidance) as Record<string, unknown>
  if (!definition.schemaConstraints) {
    return projected as Tool["inputSchema"]
  }
  return {
    ...projected,
    ...definition.schemaConstraints,
  } as Tool["inputSchema"]
}

/**
 * Select one *structurally proven* action branch from a discriminated union.
 * This is a true executable input schema, not a lossy documentation summary:
 * callers must echo a contract derived from this specific branch and execute
 * the same action. Flat multifunction schemas deliberately do not qualify,
 * since guessing relevant fields would conceal conditional requirements.
 */
export function focusedInputSchema(
  definition: Definition,
  action: string,
  guidance: GuidanceMode = "balanced",
): Tool["inputSchema"] | undefined {
  if (!action.trim()) return undefined
  const document = definitionInputSchema(definition, guidance) as Record<string, unknown>
  const explicit = definition.focusActions?.[action]
  if (explicit) {
    const source = document.properties
    if (!source || typeof source !== "object" || Array.isArray(source)) return undefined
    const properties = source as Record<string, unknown>
    const discriminator = properties.action
    if (!discriminator || typeof discriminator !== "object" || Array.isArray(discriminator)) return undefined
    const enumValues = (discriminator as { enum?: unknown }).enum
    if (!Array.isArray(enumValues) || !enumValues.includes(action)) return undefined
    const fields = ["rootID", "action", ...explicit.fields]
    if (fields.some((key) => !(key in properties))) return undefined
    const required = new Set([...((Array.isArray(document.required) ? document.required : []) as string[]), ...explicit.required])
    if ([...required].some((key) => !fields.includes(key))) return undefined
    const { $defs: rawDefinitions, properties: _props, required: _required, ...common } = document
    const focused = {
      ...common,
      properties: Object.fromEntries(fields.map((key) => [key, key === "action"
        ? { ...(discriminator as Record<string, unknown>), const: action, enum: [action] }
        : properties[key]])),
      required: fields.filter((key) => required.has(key)),
      additionalProperties: false,
      ...(explicit.constraints ?? {}),
    }
    const definitions = rawDefinitions && typeof rawDefinitions === "object" && !Array.isArray(rawDefinitions)
      ? rawDefinitions as Record<string, unknown> : undefined
    if (!definitions) return focused as unknown as Tool["inputSchema"]
    const needed = [...refs(focused)]
    const subset: Record<string, unknown> = {}
    const seen = new Set<string>()
    while (needed.length > 0) {
      const key = needed.shift()!
      if (seen.has(key)) continue
      seen.add(key)
      if (definitions[key] === undefined) return undefined
      subset[key] = definitions[key]
      for (const child of refs(definitions[key])) if (!seen.has(child)) needed.push(child)
    }
    return { ...focused, ...(Object.keys(subset).length ? { $defs: subset } : {}) } as unknown as Tool["inputSchema"]
  }
  const candidates = Array.isArray(document.anyOf) ? document.anyOf
    : Array.isArray(document.oneOf) ? document.oneOf : undefined
  if (!candidates || candidates.length < 2) return undefined
  const matching = candidates.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const properties = (value as Record<string, unknown>).properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false
    for (const discriminator of ["operation", "action"]) {
      const field = (properties as Record<string, unknown>)[discriminator]
      if (!field || typeof field !== "object" || Array.isArray(field)) continue
      const node = field as Record<string, unknown>
      if (node.const === action || (Array.isArray(node.enum) && node.enum.length === 1 && node.enum[0] === action))
        return true
    }
    return false
  })
  if (matching.length !== 1) return undefined

  const { anyOf: _anyOf, oneOf: _oneOf, $defs: rawDefs, ...common } = document
  const chosen = { ...common, ...(matching[0] as Record<string, unknown>) }
  const definitions = rawDefs && typeof rawDefs === "object" && !Array.isArray(rawDefs)
    ? rawDefs as Record<string, unknown> : undefined
  if (!definitions) return chosen as Tool["inputSchema"]

  const selected: Record<string, unknown> = {}
  const queue = [...refs(chosen)]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const value = definitions[name]
    if (value === undefined) continue
    selected[name] = value
    for (const child of refs(value)) if (!seen.has(child)) queue.push(child)
  }
  return {
    ...chosen,
    ...(Object.keys(selected).length ? { $defs: selected } : {}),
  } as Tool["inputSchema"]
}

export * as OxpSchemaProjection from "./schema-projection"