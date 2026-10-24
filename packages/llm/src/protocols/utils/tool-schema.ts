import type { JsonSchema, ModelToolSchemaCompatibility } from "../../schema"
import { isRecord } from "../../utils/record"
import { GeminiToolSchema } from "./gemini-tool-schema"

const removeNullSchemas = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeNullSchemas)
  if (!isRecord(value)) return value
  const fields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "anyOf")
      .map(([key, field]) => [key, removeNullSchemas(field)]),
  )
  if (!Array.isArray(value.anyOf)) return fields
  const variants = value.anyOf.filter((variant) => !isRecord(variant) || variant.type !== "null").map(removeNullSchemas)
  if (variants.length === 1 && isRecord(variants[0])) return { ...fields, ...variants[0] }
  return { ...fields, anyOf: variants }
}

const tupleItemsSchema = (items: ReadonlyArray<unknown>) => {
  const projected = items.map(moonshotNode)
  if (projected.length === 0) return {}
  if (projected.length === 1) return projected[0]
  return { anyOf: projected }
}

const moonshotNode = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(moonshotNode)
  if (!isRecord(schema)) return schema
  if (typeof schema.$ref === "string") return { $ref: schema.$ref }
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "items" && Array.isArray(value)) return [[key, tupleItemsSchema(value)]]
      if (key === "prefixItems") {
        if ("items" in schema) return []
        return [["items", tupleItemsSchema(Array.isArray(value) ? value : [])]]
      }
      if (key === "unevaluatedItems") return []
      return [[key, moonshotNode(value)]]
    }),
  )
}

const moonshot = (schema: JsonSchema): JsonSchema => {
  const projected = moonshotNode(schema)
  return isRecord(projected) ? projected : {}
}

const openAI = (schema: JsonSchema): JsonSchema => {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : []
  const flattened =
    variants.length === 0
      ? { ...schema, type: "object" }
      : {
          ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf")),
          type: "object",
          properties: variants.reduce(
            (properties, variant) => ({ ...(isRecord(variant.properties) ? variant.properties : {}), ...properties }),
            {},
          ),
          additionalProperties: false,
        }
  const normalized = removeNullSchemas(flattened)
  return isRecord(normalized) ? normalized : { type: "object" }
}

// Anthropic requires an object-shaped tool input_schema with no composition
// keywords at its root. Keep nested unions intact: they are legal property
// schemas, and rewriting them would unnecessarily change the tool contract.
// This is a wire projection only; the executable tool retains its source schema.
const anthropic = (schema: JsonSchema): JsonSchema => {
  const combiners = ["oneOf", "anyOf", "allOf"] as const
  if (!combiners.some((key) => key in schema)) return schema

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema).filter(([key]) => !combiners.some((combiner) => combiner === key)),
  )
  const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
  )
  const hints: string[] = []

  for (const combiner of combiners) {
    const branches = Array.isArray(schema[combiner]) ? schema[combiner].filter(isRecord) : []
    if (branches.length === 0) continue

    // AllOf requires the union of required fields. AnyOf/OneOf can safely
    // require only fields common to every alternative.
    const requirements = branches.map((branch) =>
      Array.isArray(branch.required)
        ? branch.required.filter((key): key is string => typeof key === "string")
        : [],
    )
    if (combiner === "allOf") {
      for (const fields of requirements) for (const field of fields) required.add(field)
    } else {
      for (const field of requirements[0] ?? []) {
        if (requirements.every((fields) => fields.includes(field))) required.add(field)
      }
    }

    // Preserve all discoverable parameters. If alternatives disagree on a
    // property type, retain the alternatives *inside that property*, where
    // Anthropic does allow compositions.
    for (const branch of branches) {
      if (!isRecord(branch.properties)) continue
      for (const [field, definition] of Object.entries(branch.properties)) {
        if (!(field in properties)) {
          properties[field] = definition
          continue
        }
        if (JSON.stringify(properties[field]) === JSON.stringify(definition)) continue
        if (isRecord(schema.properties) && field in schema.properties) continue
        const key = combiner === "allOf" ? "allOf" : "anyOf"
        const previous = properties[field]
        if (isRecord(previous) && Object.keys(previous).length === 1 && Array.isArray(previous[key])) {
          properties[field] = { [key]: [...previous[key], definition] }
        } else {
          properties[field] = { [key]: [previous, definition] }
        }
      }
    }

    // Add required-only names after collecting typed branch properties, so
    // an untyped placeholder never masks a meaningful property definition.
    for (const fields of requirements) {
      for (const field of fields) {
        if (!(field in properties)) properties[field] = {}
      }
    }

    // Required-only branches (common in MCP rootID/path and action unions)
    // otherwise lose their cross-field constraint. Keep a short model-facing
    // hint; the original tool still performs authoritative validation.
    if (requirements.length === branches.length && requirements.every((fields) => fields.length > 0)) {
      const join = combiner === "allOf" ? " and " : " or "
      const condition = combiner === "oneOf" ? "exactly one" : combiner === "anyOf" ? "at least one" : "all"
      hints.push(`${condition} of (${requirements.map((fields) => fields.join(" + ")).join(join)})`)
    }
  }

  result.type = "object"
  result.properties = properties
  if (required.size) result.required = [...required]
  else delete result.required
  if (hints.length) {
    const note = `Parameter combinations: ${hints.join("; ")}.`
    result.description = [typeof schema.description === "string" ? schema.description : "", note]
      .filter(Boolean)
      .join(" ")
  }
  return result
}

const gemini = (schema: JsonSchema): JsonSchema => GeminiToolSchema.convert(schema) ?? {}

const modelCompatibility = (
  schema: JsonSchema,
  compatibility: ModelToolSchemaCompatibility | undefined,
): JsonSchema => {
  if (compatibility === undefined) return schema
  switch (compatibility) {
    case "gemini":
      return gemini(schema)
    case "moonshot":
      return moonshot(schema)
  }
}

export const ToolSchemaProjection = {
  anthropic,
  gemini,
  modelCompatibility,
  moonshot,
  openAI,
} as const
