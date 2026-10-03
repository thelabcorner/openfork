import { Schema } from "effect"
import type { Tool } from "@modelcontextprotocol/server"

export interface Definition {
  readonly schema: Schema.Top
  readonly schemaConstraints?: Readonly<Record<string, unknown>>
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact)
  if (!value || typeof value !== "object") return value
  const out = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, compact(item)]),
  ) as Record<string, unknown>

  if (Array.isArray(out.anyOf)) {
    const options = out.anyOf.filter(
      (item) =>
        !(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === "null"
        ),
    )
    const hasNumber = options.some(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === "number",
    )
    const hasNonJsonNumberSentinel = options.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      const values = (item as Record<string, unknown>).enum
      return (
        Array.isArray(values) &&
        values.some(
          (entry) =>
            entry === "NaN" ||
            entry === "Infinity" ||
            entry === "-Infinity",
        )
      )
    })
    if (hasNumber && hasNonJsonNumberSentinel) return { type: "number" }
    if (options.length === 1) return options[0]
    out.anyOf = options
  }

  if (out.type && Array.isArray(out.allOf)) {
    const mergeable = out.allOf.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !("type" in (item as Record<string, unknown>)) &&
        !("anyOf" in (item as Record<string, unknown>)) &&
        !("oneOf" in (item as Record<string, unknown>)) &&
        !("$ref" in (item as Record<string, unknown>)),
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

export function inputSchema(schema: Schema.Top): Tool["inputSchema"] {
  const document = Schema.toJsonSchemaDocument(schema, {
    additionalProperties: false,
  })
  const projected = compact(document.schema) as Record<string, unknown>
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
    const compacted = compact(definition)
    defs[name] = compacted
    for (const dependency of refs(compacted)) {
      if (!seen.has(dependency)) pending.push(dependency)
    }
  }
  return { ...projected, $defs: defs } as unknown as Tool["inputSchema"]
}

export function definitionInputSchema(
  definition: Definition,
): Tool["inputSchema"] {
  const projected = inputSchema(definition.schema) as Record<string, unknown>
  if (!definition.schemaConstraints) {
    return projected as Tool["inputSchema"]
  }
  return {
    ...projected,
    ...definition.schemaConstraints,
  } as Tool["inputSchema"]
}

export * as OxpSchemaProjection from "./schema-projection"