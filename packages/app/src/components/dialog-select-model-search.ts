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

export const prepareModelSearchFields = (values: string[]) =>
  values.map((value) => {
    const normalized = normalizeModelSearch(value)
    return { normalized, compact: normalized.replaceAll(" ", "") }
  })

export const createModelSearchMatcher = (query: string) => {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return () => true
  const compactTokens = tokens.map((token) => token.replaceAll(" ", ""))

  return (fields: ReturnType<typeof prepareModelSearchFields>) =>
    tokens.every((token, index) => fields.some((field) => field.normalized.includes(token) || field.compact.includes(compactTokens[index])))
}

export const matchesModelSearch = (query: string, values: string[]) =>
  createModelSearchMatcher(query)(prepareModelSearchFields(values))
