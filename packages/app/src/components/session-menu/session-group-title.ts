const GENERIC = new Set([
  "a",
  "an",
  "and",
  "batch",
  "child",
  "delegated",
  "for",
  "from",
  "group",
  "in",
  "new",
  "of",
  "oxp",
  "session",
  "the",
  "to",
  "worker",
  "workers",
])

function tokens(title: string) {
  return title.match(/[A-Za-z0-9][A-Za-z0-9._+#-]*/g) ?? []
}

/**
 * Derive one group label from the compact member titles already present in the
 * group projection. This deliberately does not regenerate member titles or
 * hydrate their histories.
 */
export function generateSessionGroupTitle(titles: readonly (string | undefined)[]) {
  const members = titles
    .map((title) => (title ?? "").trim())
    .filter((title) => title && !/^oxp delegated (?:batch|workers?)$/i.test(title))
  if (members.length === 0) return undefined

  const counts = new Map<string, { display: string; count: number; first: number }>()
  let order = 0
  for (const title of members) {
    const seen = new Set<string>()
    for (const token of tokens(title)) {
      const key = token.toLocaleLowerCase("en-US")
      if (GENERIC.has(key) || /^v\d+$/i.test(token) || seen.has(key)) continue
      seen.add(key)
      const prior = counts.get(key)
      if (prior) prior.count += 1
      else counts.set(key, { display: token, count: 1, first: order })
      order += 1
    }
  }

  const repeated = [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count || left.first - right.first)
  if (repeated.length > 0) {
    // Keep the member-title token order for ties. Two or three repeated terms
    // usually identify the shared task area without adding a redundant
    // "delegated batch" suffix that the group icon/count already conveys.
    return repeated
      .slice(0, 3)
      .sort((left, right) => left.first - right.first)
      .map((entry) => entry.display)
      .join(" ")
      .slice(0, 80)
  }

  // With unrelated tasks there is no honest shared topic to infer. Use the
  // best available member title and make the representative nature explicit.
  const representative = members
    .filter((title) => !/^new session(?:\s|$)|^child session(?:\s|$)/i.test(title))
    .sort((left, right) => right.length - left.length)[0]
  if (!representative) return undefined
  const base = representative.slice(0, 64).trim()
  return members.length > 1 ? `${base} +${members.length - 1}`.slice(0, 80) : base
}
