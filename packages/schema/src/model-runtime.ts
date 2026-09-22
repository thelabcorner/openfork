export type Primitive = "language" | "system-one"

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
 * This helper is deliberately Effect-free because catalog normalization runs on
 * every client startup. Runtime schema construction belongs in model.ts; simple
 * model classification does not.
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
