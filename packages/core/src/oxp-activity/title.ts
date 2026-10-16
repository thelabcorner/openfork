export type InvocationTitleEvidence = {
  readonly tool: string
  readonly action?: string | null
  readonly safeSummary?: unknown
  readonly request?: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function string(value: unknown) {
  if (typeof value !== "string") return undefined
  const result = value.replace(/\s+/g, " ").trim()
  return result || undefined
}

function generic(value: string) {
  return /^(?:oxp delegated (?:batch|workers?)|new session|child session|session)$/i.test(value)
}

function compact(value: string, limit = 96) {
  const clean = string(value)?.replace(/[<>`]/g, "")
  if (!clean || generic(clean)) return undefined
  let output = ""
  let count = 0
  for (const char of clean) {
    if (count >= limit || new TextEncoder().encode(output + char).length > 240)
      return output.trimEnd() + "…"
    output += char
    count += 1
  }
  return output
}

function basename(value: unknown) {
  const path = string(value)
  const name = path?.split(/[\\/]/).filter(Boolean).at(-1)
  return name && name !== "." && name !== ".." ? name : undefined
}

function callTitle(item: InvocationTitleEvidence) {
  const request = object(item.request)
  const args = object(request?.args)
  return compact(string(args?.title) ?? "", 128)
}

function workerBatchTitle(item: InvocationTitleEvidence) {
  if (item.tool !== "openfork_worker") return undefined
  const args = object(object(item.request)?.args)
  const titles = Array.isArray(args?.workerTitles)
    ? args.workerTitles.flatMap((value) => {
        const title = compact(string(value) ?? "", 72)
        return title ? [title] : []
      })
    : []
  if (titles.length === 0) return undefined
  if (titles.length === 1) return titles[0]

  const ignored = new Set(["a", "an", "and", "batch", "for", "from", "in", "of", "the", "to", "worker", "workers"])
  const frequency = new Map<string, { display: string; count: number; first: number }>()
  let order = 0
  for (const title of titles) {
    const seen = new Set<string>()
    for (const token of title.match(/[A-Za-z0-9][A-Za-z0-9._+#-]*/g) ?? []) {
      const key = token.toLocaleLowerCase("en-US")
      if (ignored.has(key) || /^v\d+$/i.test(token) || seen.has(key)) continue
      seen.add(key)
      const prior = frequency.get(key)
      if (prior) prior.count += 1
      else frequency.set(key, { display: token, count: 1, first: order })
      order += 1
    }
  }
  const shared = [...frequency.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count || left.first - right.first)
    .slice(0, 3)
    .sort((left, right) => left.first - right.first)
  if (shared.length > 0) return compact(shared.map((entry) => entry.display).join(" "), 96)

  const representative = [...titles].sort((left, right) => right.length - left.length)[0]
  return representative ? compact(`${representative} +${titles.length - 1}`, 96) : undefined
}

function paths(item: InvocationTitleEvidence) {
  if (item.tool !== "edit" && item.tool !== "write" && item.tool !== "patch") return []
  const summary = object(item.safeSummary)
  const result: string[] = []
  if (Array.isArray(summary?.files)) {
    for (const entry of summary.files) {
      const file = object(entry)
      const name = basename(file?.path)
      if (name) result.push(name)
    }
  }
  if (typeof summary?.path === "string") {
    const name = basename(summary.path)
    if (name) result.push(name)
  }
  return result
}

/**
 * Build a useful activity label from bounded, redacted OXP tool-call evidence.
 * Raw prompts, arguments and result bodies are intentionally not consulted.
 */
export function generateOxpActivityTitle(items: readonly InvocationTitleEvidence[]) {
  // Explicit task labels supplied to OXP worker tools are the strongest title
  // evidence. Default worker names are ignored so they cannot replace the
  // equally unhelpful workspace alias shown by older rows.
  for (const item of items) {
    const title = callTitle(item)
    if (title) return title
    const batchTitle = workerBatchTitle(item)
    if (batchTitle) return batchTitle
  }

  const changedFiles = [...new Set(items.flatMap(paths))]
  if (changedFiles.length === 1) return compact(`Update ${changedFiles[0]}`, 128)
  if (changedFiles.length === 2) return compact(`Update ${changedFiles[0]} and ${changedFiles[1]}`, 128)
  if (changedFiles.length > 2) return `Update ${changedFiles.length} files`

  for (const item of items) {
    const summary = object(item.safeSummary)
    if (item.tool === "find") {
      const pattern = compact(string(summary?.pattern) ?? "", 80)
      if (pattern && pattern !== "**/*" && pattern !== "*") return `Find ${pattern}`
    }
    if (item.tool === "read") {
      const name = basename(summary?.path)
      if (name) return `Inspect ${name}`
    }
    if (item.tool === "git") {
      const ref = compact(string(summary?.ref) ?? string(summary?.branch) ?? "", 72)
      if (ref) return `Review Git ${ref}`
      if (item.action) return `Git ${item.action}`
    }
    if (item.tool === "capability") {
      const capability = compact(string(summary?.capability) ?? "", 80)
      if (capability) return `Use ${capability.split("/").at(-1)}`
    }
    if (item.tool === "openfork_worker") {
      const count = Number(summary?.workerCount)
      if (Number.isSafeInteger(count) && count > 0) return `Delegate ${count} workers`
      return "Delegate worker tasks"
    }
  }

  return undefined
}
