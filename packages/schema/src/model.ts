export * as Model from "./model"

import { Schema } from "effect"
import { optional } from "./schema"
import { Provider } from "./provider"
import { statics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  /**
   * Stable provider-account identity. This is deliberately separate from
   * Model.ID: providers that still route through an account-qualified model id
   * lower this field only at their runtime/catalog boundary.
   */
  accountID: Schema.String.pipe(optional),
  variant: VariantID.pipe(optional),
}).annotate({ identifier: "Model.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export const Primitive = Schema.Literals(["language", "system-one"]).annotate({ identifier: "Model.Primitive" })
export type Primitive = typeof Primitive.Type

/** Resolve the computational primitive represented by one materialized model. */
export function resolvePrimitive(
  _providerID: string,
  model: { readonly id: string; readonly primitive?: Primitive },
): Primitive {
  return model.primitive ?? "language"
}

function hasEmbeddingIdentity(value: string | undefined) {
  if (!value) return false
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token === "embed" || token === "embeddings" || token.startsWith("embedding"))
}

/**
 * True only when a catalog row is eligible for conversational generation.
 *
 * Some third-party/local provider plugins expose embedding models through a
 * language-model shaped catalog without primitive metadata. Treat obvious
 * embedding identities as non-conversational even when the legacy primitive
 * fallback is "language".
 */
export function isLanguageModel(
  providerID: string,
  model: {
    readonly id: string
    readonly primitive?: Primitive
    readonly family?: string
    readonly name?: string
  },
) {
  if (resolvePrimitive(providerID, model) !== "language") return false
  return ![model.id, model.family, model.name].some(hasEmbeddingIdentity)
}

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
}).annotate({ identifier: "Model.Cost" })

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...Provider.AISDK.fields,
  }),
  Schema.Struct({
    id: ID,
    ...Provider.Native.fields,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Model.Api" })
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  name: Schema.String,
  primitive: Primitive.pipe(optional),
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...Provider.Request.fields,
    variant: Schema.String.pipe(optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...Provider.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          primitive: "language",
          api: { id: modelID, type: "native", settings: {} },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )
