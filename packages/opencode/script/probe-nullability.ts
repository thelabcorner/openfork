import { Schema } from "effect"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import * as JsonSchema from "effect/JsonSchema"

const Payload = Schema.Struct({
  a: Schema.NullOr(Schema.Finite),
  b: Schema.NullOr(Schema.String),
  c: Schema.Union([Schema.String, Schema.Null]),
  d: Schema.optional(Schema.NullOr(Schema.Finite)),
  e: Schema.NullOr(Schema.Number),
  f: Schema.optional(Schema.NullOr(Schema.String)),
})

const multi = SchemaRepresentation.toJsonSchemaMultiDocument({
  schemas: [Payload] as any,
  references: {},
  annotations: {},
} as any)

console.log(JSON.stringify(JsonSchema.toMultiDocumentOpenApi3_1(multi as any), null, 2).slice(0, 4000))