export const normalizeModelSearch = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

const searchTokens = (value: string) => normalizeModelSearch(value).split(" ").filter(Boolean)

export type PreparedModelSearchFields = { normalized: string; compact: string }

// Search fields are structural and are prepared once per model/catalog
// revision. Join them with a sentinel that normalization can never emit so a
// query cannot accidentally match across two field boundaries. This preserves
// the previous field-wise substring semantics while turning the hot matcher
// from tokens × fields scans into two native string searches per token.
export const prepareModelSearchFields = (values: string[]): PreparedModelSearchFields => {
  const normalized = values.map(normalizeModelSearch)
  return {
    normalized: normalized.join("\0"),
    compact: normalized.map((value) => value.replaceAll(" ", "")).join("\0"),
  }
}

export const createModelSearchMatcher = (query: string) => {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return () => true

  return (fields: PreparedModelSearchFields | undefined) =>
    !!fields &&
    tokens.every((token) => fields.normalized.includes(token) || fields.compact.includes(token))
}

export const matchesModelSearch = (query: string, values: string[]) =>
  createModelSearchMatcher(query)(prepareModelSearchFields(values))
