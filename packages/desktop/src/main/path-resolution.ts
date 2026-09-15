import { join } from "node:path"

export const PATH_RESOLVE_CANDIDATE_LIMIT = 128
const FIRST_SPECULATIVE_BATCH = 8
const STEADY_SPECULATIVE_BATCH = 24

export function expandHomePath(path: string, home: string) {
  if (path === "~") return home
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, ...path.slice(2).split(/[\\/]+/))
  return path
}

export async function firstExistingPath(
  paths: readonly string[],
  exists: (path: string) => Promise<boolean>,
  expand: (path: string) => string,
) {
  const limit = Math.min(paths.length, PATH_RESOLVE_CANDIDATE_LIMIT)
  if (limit === 0) return null

  let successfulProbe = false
  let lastError: unknown

  const probe = async (candidate: string | undefined) => {
    if (!candidate) return { path: undefined, found: false, completed: false } as const
    const path = expand(candidate)
    try {
      const found = await exists(path)
      return { path, found, completed: true } as const
    } catch (error) {
      return { path, found: false, completed: false, error } as const
    }
  }

  const consume = (results: Awaited<ReturnType<typeof probe>>[]) => {
    for (const result of results) {
      if (result.completed) successfulProbe = true
      if ("error" in result) lastError = result.error
      if (result.found && result.path) return result.path
    }
  }

  // The file index is ranked. In the overwhelmingly common case candidate 0 is
  // correct, so preserve a single-stat fast path instead of paying a speculative
  // I/O burst on every click. Adaptive filesystem experiments then found that an
  // 8-wide first miss batch best serves near-front hits, while 24-wide follow-up
  // batches dominate the middle/deep cases without the resource burst of 32.
  const first = await probe(paths[0])
  const firstFound = consume([first])
  if (firstFound) return firstFound

  let start = 1
  let batchSize = FIRST_SPECULATIVE_BATCH
  while (start < limit) {
    const end = Math.min(limit, start + batchSize)
    const results = await Promise.all(Array.from({ length: end - start }, (_, offset) => probe(paths[start + offset])))
    const found = consume(results)
    if (found) return found
    start = end
    batchSize = STEADY_SPECULATIVE_BATCH
  }

  if (!successfulProbe && lastError !== undefined) throw lastError
  return null
}
